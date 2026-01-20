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
  | "CROSSED_BOOK";     // Bid >= Ask (arbitrage opportunity)

/**
 * Prediction market specific trigger types
 * Only valid for BINARY_OPTION and MULTI_OUTCOME instruments
 */
export type PredictionMarketTriggerType =
  | "ARBITRAGE_BUY"     // YES_ask + NO_ask < threshold (buy both for guaranteed profit)
  | "ARBITRAGE_SELL";   // YES_bid + NO_bid > threshold (sell both for guaranteed profit)

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
  side?: "BID" | "ASK";           // For PRICE_ABOVE/BELOW, which side to watch
  window_ms?: number;             // For PRICE_MOVE, time window in milliseconds
  counterpart_asset_id?: string;  // For ARBITRAGE triggers, the other side of the market
}

/**
 * Registered trigger with metadata
 */
export interface Trigger {
  id: string;                     // Unique trigger ID
  market_source: MarketSource;    // Market this trigger is for
  asset_id: string;               // Asset to monitor (or "*" for all in market)
  condition: TriggerCondition;
  webhook_url: string;            // URL to POST when trigger fires
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
  market_source: MarketSource;
  asset_id: string;
  condition_id: string;
  fired_at: number;               // Microsecond timestamp
  latency_us: number;             // Time from source_ts to fired_at

  // Current market state
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid_price: number | null;
  spread_bps: number | null;

  // Trigger-specific data
  threshold: number;
  actual_value: number;           // The value that triggered (price, spread, ratio, etc.)

  // Arbitrage-specific fields (for prediction market triggers)
  counterpart_asset_id?: string;
  counterpart_best_bid?: number | null;
  counterpart_best_ask?: number | null;
  sum_of_asks?: number;           // YES_ask + NO_ask (for ARBITRAGE_BUY)
  sum_of_bids?: number;           // YES_bid + NO_bid (for ARBITRAGE_SELL)
  potential_profit_bps?: number;  // Estimated profit in basis points

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
 */
export interface PriceHistoryEntry {
  ts: number;
  mid_price: number;
}

/**
 * Trigger evaluation context
 * Passed to trigger evaluators with current market state
 */
export interface TriggerContext {
  /** Latest BBO for all assets (for cross-asset triggers like arbitrage) */
  latestBBO: Map<string, { best_bid: number | null; best_ask: number | null; ts: number }>;

  /** Price history for PRICE_MOVE triggers */
  priceHistory: Map<string, PriceHistoryEntry[]>;

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
