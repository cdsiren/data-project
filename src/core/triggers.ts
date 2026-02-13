// src/core/triggers.ts
// Trigger types for the ultra-low-latency event system
// Processed directly in Durable Object, bypassing queues for <50ms latency

import type { MarketSource } from "./enums";

/**
 * Generic trigger types that work across all markets
 */
export type GenericTriggerType =
  | "PRICE_ABOVE"       // Best bid or ask crosses above threshold
  | "PRICE_BELOW"       // Best bid or ask crosses below threshold
  | "SPREAD_NARROW"     // Spread narrows below threshold (in bps)
  | "SPREAD_WIDE"       // Spread widens above threshold (in bps)
  | "IMBALANCE_BID"     // Book imbalance favors bids (ratio > threshold)
  | "IMBALANCE_ASK"     // Book imbalance favors asks (ratio < -threshold)
  | "SIZE_SPIKE"        // Large size appears at top of book
  | "PRICE_MOVE"        // Price moves X% within Y seconds
  | "CROSSED_BOOK"      // Bid >= Ask (arbitrage opportunity)
  | "EMPTY_BOOK"        // Both sides of book are empty (null/zero size) - critical market state
  // HFT Triggers for Avellaneda-Stoikov market making
  | "VOLATILITY_SPIKE"  // Realized volatility exceeds threshold (AS model: σ² in spread formula)
  | "MICROPRICE_DIVERGENCE" // Microprice diverges from mid (short-term alpha signal)
  | "IMBALANCE_SHIFT"   // Rapid change in book imbalance (order flow detection)
  | "MID_PRICE_TREND"   // Consecutive mid price moves in same direction (inventory mgmt)
  | "QUOTE_VELOCITY"    // BBO update rate exceeds threshold (competitive pressure)
  | "STALE_QUOTE"       // No BBO update for threshold ms (market halt/data issue)
  | "LARGE_FILL";       // Significant size removed from book (whale/large trade detection)

/**
 * Prediction market specific trigger types
 * Only valid for BINARY_OPTION and MULTI_OUTCOME instruments
 */
export type PredictionMarketTriggerType =
  | "ARBITRAGE_BUY"     // YES_ask + NO_ask < threshold (buy both for guaranteed profit)
  | "ARBITRAGE_SELL"    // YES_bid + NO_bid > threshold (sell both for guaranteed profit)
  | "MULTI_OUTCOME_ARBITRAGE"; // Sum of all outcome asks < threshold (N-outcome arb)

/**
 * All trigger types
 */
export type TriggerType = GenericTriggerType | PredictionMarketTriggerType;

/**
 * Trigger condition configuration
 */
export interface TriggerCondition {
  type: TriggerType;
  threshold: number;              // Price, spread_bps, ratio, or percentage depending on type
  side?: "BID" | "ASK";           // For PRICE_ABOVE/BELOW, SIZE_SPIKE, MID_PRICE_TREND, LARGE_FILL
  window_ms?: number;             // For PRICE_MOVE, VOLATILITY_SPIKE, IMBALANCE_SHIFT, QUOTE_VELOCITY
  counterpart_asset_id?: string;  // For ARBITRAGE triggers, the other side of the market
  outcome_asset_ids?: string[];   // For MULTI_OUTCOME_ARBITRAGE, all outcome token IDs
}

/**
 * Registered trigger with metadata
 */
export interface Trigger {
  id: string;                     // Unique trigger ID
  market_source?: MarketSource;   // Market this trigger is for (optional for legacy compatibility)
  asset_id: string;               // Asset to monitor (or "*" for all in market)
  condition: TriggerCondition;
  webhook_url?: string;           // Optional URL to POST when trigger fires (SSE always receives)
  webhook_secret?: string;        // Optional HMAC secret for webhook verification
  enabled: boolean;
  cooldown_ms: number;            // Minimum time between trigger fires (default 1000ms)
  created_at: number;
  metadata?: Record<string, string>; // User-defined metadata passed through to webhook
}

/**
 * Event fired when a trigger matches
 * Sent immediately via webhook (bypasses all queues)
 */
export interface TriggerEvent {
  trigger_id: string;
  trigger_type: TriggerType;
  market_source?: MarketSource;   // Optional for legacy compatibility
  asset_id: string;
  condition_id: string;
  fired_at: number;               // Microsecond timestamp

  // Dual latency tracking
  total_latency_us: number;       // fired_at - source_ts (includes network)
  processing_latency_us: number;  // fired_at - ingestion_ts (DO only)

  // Current market state
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  spread_bps: number | null;

  // Trigger-specific data
  threshold: number;
  actual_value: number;           // The value that triggered (price, spread, ratio, etc.)

  // Arbitrage-specific fields (for prediction market triggers)
  /** The counterpart outcome's asset ID (e.g., NO token for YES trigger) */
  counterpart_asset_id?: string;
  /** Counterpart's best bid price */
  counterpart_best_bid?: number | null;
  /** Counterpart's best ask price */
  counterpart_best_ask?: number | null;
  /** Counterpart's bid-side liquidity at BBO. Units: shares */
  counterpart_bid_size?: number | null;
  /** Counterpart's ask-side liquidity at BBO. Units: shares */
  counterpart_ask_size?: number | null;
  /** YES_ask + NO_ask (for ARBITRAGE_BUY) */
  sum_of_asks?: number;
  /** YES_bid + NO_bid (for ARBITRAGE_SELL) */
  sum_of_bids?: number;
  /** Estimated profit in basis points: (1 - sum) * 10000 for buy, (sum - 1) * 10000 for sell */
  potential_profit_bps?: number;

  /**
   * Maximum executable size for the arbitrage opportunity.
   *
   * For ARBITRAGE_BUY/SELL: min(primary_side_size, counterpart_side_size)
   * For MULTI_OUTCOME_ARBITRAGE: min(ask_size across all outcomes)
   *
   * This is the liquidity-constrained size - the maximum number of shares
   * you can trade while maintaining the arbitrage spread on all sides.
   *
   * **Important for MULTI_OUTCOME_ARBITRAGE**: This is the amount to buy of EACH
   * outcome, not the total. To realize the arbitrage, buy `recommended_size` shares
   * of every asset in `outcome_asset_ids`.
   *
   * A value of 0 indicates the arbitrage exists but has no liquidity on one or more sides.
   * Only populated for: ARBITRAGE_BUY, ARBITRAGE_SELL, MULTI_OUTCOME_ARBITRAGE
   *
   * Units: shares or contracts
   */
  recommended_size?: number;

  /**
   * Total capital required (or received) to execute the recommended size.
   *
   * For ARBITRAGE_BUY: recommended_size * (YES_ask + NO_ask) = capital needed
   * For ARBITRAGE_SELL: recommended_size * (YES_bid + NO_bid) = capital received
   *
   * This represents the gross transaction amount before considering profit.
   * Only populated for: ARBITRAGE_BUY, ARBITRAGE_SELL, MULTI_OUTCOME_ARBITRAGE
   *
   * Units: dollars (USD)
   */
  max_notional?: number;

  /**
   * Expected profit from executing the recommended size.
   * Calculated as: recommended_size * profit_per_share
   *
   * For ARBITRAGE_BUY: recommended_size * (1 - sum_of_asks)
   * For ARBITRAGE_SELL: recommended_size * (sum_of_bids - 1)
   *
   * This is the theoretical profit before fees, slippage, and gas costs.
   * A value of 0 indicates zero liquidity (recommended_size = 0).
   * Only populated for: ARBITRAGE_BUY, ARBITRAGE_SELL, MULTI_OUTCOME_ARBITRAGE
   *
   * Units: dollars (USD)
   */
  expected_profit?: number;

  // HFT trigger-specific fields
  volatility?: number;            // VOLATILITY_SPIKE: realized volatility %
  microprice?: number;            // MICROPRICE_DIVERGENCE: calculated microprice
  microprice_divergence_bps?: number; // MICROPRICE_DIVERGENCE: divergence from mid in bps
  imbalance_delta?: number;       // IMBALANCE_SHIFT: change in imbalance
  previous_imbalance?: number;    // IMBALANCE_SHIFT: imbalance at window start
  current_imbalance?: number;     // IMBALANCE_SHIFT: current imbalance
  consecutive_moves?: number;     // MID_PRICE_TREND: number of consecutive moves
  trend_direction?: "UP" | "DOWN"; // MID_PRICE_TREND: direction of trend
  updates_per_second?: number;    // QUOTE_VELOCITY: BBO update rate
  stale_ms?: number;              // STALE_QUOTE: time since last update
  outcome_ask_sum?: number;       // MULTI_OUTCOME_ARBITRAGE: sum of all outcome asks
  outcome_count?: number;         // MULTI_OUTCOME_ARBITRAGE: number of outcomes
  fill_notional?: number;         // LARGE_FILL: notional value of removed size
  fill_side?: "BID" | "ASK";      // LARGE_FILL: which side had size removed
  size_delta?: number;            // LARGE_FILL: size change (negative = removed)

  // Context
  book_hash: string;
  sequence_number: number;
  metadata?: Record<string, string>;
}

/**
 * Response from trigger registration
 */
export interface TriggerRegistration {
  trigger_id: string;
  status: "created" | "updated" | "error";
  message?: string;
}

/**
 * Price history entry for PRICE_MOVE trigger
 * Stores the midpoint (best_bid + best_ask) / 2 for accurate price movement detection
 */
export interface PriceHistoryEntry {
  ts: number;
  price: number;
}

/**
 * Imbalance history entry for IMBALANCE_SHIFT trigger
 */
export interface ImbalanceHistoryEntry {
  imbalance: number;
  ts: number;
}

/**
 * Trigger evaluation context
 * Passed to trigger evaluators with current market state
 */
export interface TriggerContext {
  /** Latest BBO for all assets (for cross-asset triggers like arbitrage)
   * Includes stale flag to prevent false arbitrage signals from mismatched YES/NO data
   * Includes size data for trade sizing calculations
   */
  latestBBO: Map<string, {
    best_bid: number | null;
    best_ask: number | null;
    bid_size: number | null;
    ask_size: number | null;
    ts: number;
    /** Whether this BBO data is stale (counterpart updated more recently). Always set explicitly. */
    stale: boolean;
  }>;

  /** Price history for PRICE_MOVE and VOLATILITY_SPIKE triggers */
  priceHistory: Map<string, PriceHistoryEntry[]>;

  /** Imbalance history for IMBALANCE_SHIFT trigger */
  imbalanceHistory: Map<string, ImbalanceHistoryEntry[]>;

  /** Current timestamp (microseconds) */
  nowUs: number;
}

/**
 * Result of trigger evaluation
 */
export interface TriggerEvaluationResult {
  fired: boolean;
  event?: TriggerEvent;
}

/**
 * Pre-computed bounds for trigger pre-filtering.
 * Used to quickly skip trigger evaluation when BBO cannot possibly fire the trigger.
 * null values mean "no constraint" on that dimension.
 */
export interface TriggerBounds {
  minBid: number | null;
  maxBid: number | null;
  minAsk: number | null;
  maxAsk: number | null;
  minSpreadBps: number | null;
  maxSpreadBps: number | null;
  minBidSize: number | null;
  minAskSize: number | null;
}

/**
 * Compute bounds for a trigger to enable fast pre-filtering.
 * Returns the BBO constraints that MUST be met for the trigger to possibly fire.
 *
 * For example:
 * - PRICE_ABOVE with threshold 0.5 on BID: minBid = 0.5
 * - PRICE_BELOW with threshold 0.3 on ASK: maxAsk = 0.3
 * - SPREAD_NARROW with threshold 100: maxSpreadBps = 100
 *
 * @param trigger The trigger to compute bounds for
 * @returns TriggerBounds with constraints, null values mean "no constraint"
 */
// ============================================================
// COMPOUND TRIGGER TYPES
// For multi-market graph-based triggers
// ============================================================

/**
 * Modes for evaluating compound trigger conditions.
 * - ALL_OF: All conditions must fire (AND logic)
 * - ANY_OF: At least one condition must fire (OR logic)
 * - N_OF_M: At least N of M conditions must fire
 */
export type CompoundMode = "ALL_OF" | "ANY_OF" | "N_OF_M";

/**
 * Extended condition for compound triggers.
 * Adds market_id to support cross-market conditions.
 */
export interface CompoundCondition extends TriggerCondition {
  /** Market ID (condition_id) this condition applies to */
  market_id: string;
  /** Asset ID within the market */
  asset_id: string;
  /** Human-readable label for this condition */
  label?: string;
}

/**
 * Compound trigger spanning multiple markets.
 * Extends base Trigger with multi-condition support.
 */
export interface CompoundTrigger extends Omit<Trigger, "condition"> {
  /** Evaluation mode for conditions */
  compound_mode: CompoundMode;
  /** Threshold for N_OF_M mode (min conditions that must fire) */
  compound_threshold?: number;
  /** Multiple conditions to evaluate */
  conditions: CompoundCondition[];
  /** Whether trigger spans multiple shards (auto-detected based on market_ids) */
  cross_shard: boolean;
  /** Inferred edge type for graph signal emission */
  inferred_edge_type: "correlation" | "hedge" | "causal";
  /** Markets involved in this trigger (condition_ids for edge signal generation) */
  market_ids: string[];
  /** Original user ID who created the trigger */
  user_id?: string;
  /** Single condition kept for backward compatibility (uses first condition) */
  condition: TriggerCondition;
}

/**
 * State for tracking compound trigger partial fires.
 * Used in OrderbookManager to track which conditions have fired.
 */
export interface CompoundTriggerState {
  trigger_id: string;
  /** Set of indices (as strings) of fired conditions */
  fired_conditions: Set<string>;
  /** Last evaluation timestamp (ms) */
  last_evaluation: number;
  /** Actual values when conditions fired: index -> value */
  condition_values: Map<string, number>;
  /** Version counter for optimistic locking (prevents race conditions in concurrent evaluations) */
  version: number;
}

/**
 * Event emitted when a compound trigger fires.
 * Extends TriggerEvent with compound-specific fields.
 */
export interface CompoundTriggerEvent extends TriggerEvent {
  /** All conditions and their status */
  conditions_status: Array<{
    index: number;
    market_id: string;
    asset_id: string;
    fired: boolean;
    actual_value?: number;
  }>;
  /** Indices of conditions that actually fired */
  fired_conditions: number[];
  /** Compound mode used */
  compound_mode: CompoundMode;
}

/**
 * Type guard for CompoundTrigger.
 */
export function isCompoundTrigger(trigger: Trigger | CompoundTrigger): trigger is CompoundTrigger {
  return "compound_mode" in trigger && "conditions" in trigger;
}

export function computeTriggerBounds(trigger: Trigger): TriggerBounds {
  const bounds: TriggerBounds = {
    minBid: null,
    maxBid: null,
    minAsk: null,
    maxAsk: null,
    minSpreadBps: null,
    maxSpreadBps: null,
    minBidSize: null,
    minAskSize: null,
  };

  const { type, threshold, side } = trigger.condition;

  switch (type) {
    case "PRICE_ABOVE":
      // Price must be above threshold to fire
      if (side === "ASK") {
        bounds.minAsk = threshold;
      } else {
        bounds.minBid = threshold;
      }
      break;

    case "PRICE_BELOW":
      // Price must be below threshold to fire
      if (side === "ASK") {
        bounds.maxAsk = threshold;
      } else {
        bounds.maxBid = threshold;
      }
      break;

    case "SPREAD_NARROW":
      // Spread must be below threshold to fire
      bounds.maxSpreadBps = threshold;
      break;

    case "SPREAD_WIDE":
      // Spread must be above threshold to fire
      bounds.minSpreadBps = threshold;
      break;

    case "SIZE_SPIKE":
      // Need significant size on the specified side
      if (side === "ASK") {
        bounds.minAskSize = threshold;
      } else {
        bounds.minBidSize = threshold;
      }
      break;

    case "IMBALANCE_BID":
    case "IMBALANCE_ASK":
      // Imbalance triggers need both sides to have size
      // Can't pre-filter effectively without computing imbalance
      break;

    case "CROSSED_BOOK":
      // Can't pre-filter - need to compare bid vs ask
      break;

    case "EMPTY_BOOK":
      // No pre-filtering possible - fires when book is empty
      break;

    case "PRICE_MOVE":
    case "VOLATILITY_SPIKE":
    case "MICROPRICE_DIVERGENCE":
    case "IMBALANCE_SHIFT":
    case "MID_PRICE_TREND":
    case "QUOTE_VELOCITY":
    case "STALE_QUOTE":
    case "LARGE_FILL":
      // Time-windowed or history-based triggers can't be pre-filtered
      break;

    case "ARBITRAGE_BUY":
    case "ARBITRAGE_SELL":
    case "MULTI_OUTCOME_ARBITRAGE":
      // Cross-asset triggers can't be pre-filtered with single-asset BBO
      break;
  }

  return bounds;
}
