// src/types/orderbook.ts
// Re-exports canonical types from core for backward compatibility
// Polymarket-specific types are imported from adapters/polymarket/types.ts

// ============================================================
// CANONICAL TYPES (from core - single source of truth)
// market_source is REQUIRED in all canonical types
// ============================================================
export type {
  BBOSnapshot,
  TradeTick,
  LocalOrderbook,
  OrderbookLevelChange,
  FullL2Snapshot,
  GapBackfillJob,
  HashChainState,
  RealtimeTick,
  EnhancedOrderbookSnapshot,
} from "../core/orderbook";

// Re-export enums from core
export type { TickDirection, LevelChangeType } from "../core/enums";

// ============================================================
// POLYMARKET-SPECIFIC TYPES (from adapters)
// These are market-specific WebSocket event types
// ============================================================
export type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
  PolymarketTickSizeChangeEvent,
  PolymarketWSEvent,
} from "../adapters/polymarket/types";

// ============================================================
// AGGREGATION TYPES (used for time-series analytics)
// ============================================================

/**
 * Aggregated 1-minute OHLC bar for orderbook snapshots
 * HFT-grade: true VWAP, microsecond timestamps, depth metrics
 * Reduces tick-by-tick data by ~60x while preserving key metrics
 */
export interface AggregatedSnapshot {
  asset_id: string;
  condition_id: string;
  minute: number; // Unix timestamp (ms) floored to minute

  // OHLC for best bid (string for Decimal128 precision in ClickHouse)
  open_bid: number | null;
  high_bid: number | null;
  low_bid: number | null;
  close_bid: number | null;

  // OHLC for best ask
  open_ask: number | null;
  high_ask: number | null;
  low_ask: number | null;
  close_ask: number | null;

  // True VWAP (volume-weighted, not just closing mid)
  vwap_mid: number | null;

  // Depth metrics
  avg_spread_bps: number;
  avg_bid_depth: number; // Average total bid depth
  avg_ask_depth: number; // Average total ask depth
  avg_bid_depth_5: number; // Average top 5 bid depth
  avg_ask_depth_5: number; // Average top 5 ask depth
  avg_imbalance: number;

  // Volume totals for VWAP verification
  total_bid_volume: number;
  total_ask_volume: number;

  tick_count: number;

  // Microsecond timestamps
  first_source_ts: number; // First tick timestamp (us)
  last_source_ts: number; // Last tick timestamp (us)

  // Hash chain for gap detection
  first_hash: string;
  last_hash: string;
  sequence_start: number; // First sequence number in bar
  sequence_end: number; // Last sequence number in bar
}

// ============================================================
// LOW-LATENCY TRIGGER TYPES
// Processed directly in Durable Object, bypassing queues
// ============================================================

/**
 * Trigger types for HFT signals
 */
export type TriggerType =
  | "PRICE_ABOVE"      // Best bid or ask crosses above threshold
  | "PRICE_BELOW"      // Best bid or ask crosses below threshold
  | "SPREAD_NARROW"    // Spread narrows below threshold (in bps)
  | "SPREAD_WIDE"      // Spread widens above threshold (in bps)
  | "IMBALANCE_BID"    // Book imbalance favors bids (ratio > threshold)
  | "IMBALANCE_ASK"    // Book imbalance favors asks (ratio < -threshold)
  | "SIZE_SPIKE"       // Large size appears at top of book
  | "PRICE_MOVE"       // Price moves X% within Y seconds
  | "CROSSED_BOOK"     // Bid >= Ask (arbitrage opportunity)
  | "ARBITRAGE_BUY"    // YES_ask + NO_ask < threshold (buy both for guaranteed profit)
  | "ARBITRAGE_SELL";  // YES_bid + NO_bid > threshold (sell both for guaranteed profit)

/**
 * Trigger condition configuration
 */
export interface TriggerCondition {
  type: TriggerType;
  threshold: number;           // Price, spread_bps, ratio, or percentage depending on type
  side?: "BID" | "ASK";        // For PRICE_ABOVE/BELOW, which side to watch
  window_ms?: number;          // For PRICE_MOVE, time window in milliseconds
  counterpart_asset_id?: string; // For ARBITRAGE triggers, the other side of the market (YES if this is NO, vice versa)
}

/**
 * Registered trigger with metadata
 */
export interface Trigger {
  id: string;                  // Unique trigger ID
  asset_id: string;            // Asset to monitor (or "*" for all)
  condition: TriggerCondition;
  webhook_url: string;         // URL to POST when trigger fires
  webhook_secret?: string;     // Optional HMAC secret for webhook verification
  enabled: boolean;
  cooldown_ms: number;         // Minimum time between trigger fires (default 1000ms)
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
  asset_id: string;
  condition_id: string;
  fired_at: number;            // Microsecond timestamp
  latency_us: number;          // Time from source_ts to fired_at

  // Current market state
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid_price: number | null;
  spread_bps: number | null;

  // Trigger-specific data
  threshold: number;
  actual_value: number;        // The value that triggered (price, spread, ratio, etc.)

  // Arbitrage-specific fields (for ARBITRAGE_BUY/SELL triggers)
  counterpart_asset_id?: string;
  counterpart_best_bid?: number | null;
  counterpart_best_ask?: number | null;
  sum_of_asks?: number;        // YES_ask + NO_ask (for ARBITRAGE_BUY)
  sum_of_bids?: number;        // YES_bid + NO_bid (for ARBITRAGE_SELL)
  potential_profit_bps?: number; // Estimated profit in basis points

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
