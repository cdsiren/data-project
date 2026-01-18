// src/types/orderbook.ts
// New types for orderbook handling - import into existing types.ts if needed

/**
 * Polymarket WebSocket book event
 * This is what we receive from wss://ws-subscriptions-clob.polymarket.com
 */
export interface PolymarketBookEvent {
  event_type: "book";
  asset_id: string;
  market: string; // condition_id
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string; // Unix ms as string
  hash: string; // Critical for gap detection
}

/**
 * Polymarket price_change event - incremental orderbook updates
 * Note: asset_id is inside each price_change, not at top level
 */
export interface PolymarketPriceChangeEvent {
  event_type: "price_change";
  market: string; // condition_id at top level
  price_changes: Array<{
    asset_id: string; // Asset ID is per-change, not per-event
    side: "BUY" | "SELL";
    price: string;
    size: string;
    hash?: string;
    best_bid?: string;
    best_ask?: string;
  }>;
  timestamp: string;
}

export interface PolymarketLastTradePriceEvent {
  event_type: "last_trade_price";
  asset_id: string;
  market: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  timestamp: string;
}

export interface PolymarketTickSizeChangeEvent {
  event_type: "tick_size_change";
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
}

export type PolymarketWSEvent =
  | PolymarketBookEvent
  | PolymarketPriceChangeEvent
  | PolymarketLastTradePriceEvent
  | PolymarketTickSizeChangeEvent;

/**
 * Trade tick for execution-level data (critical for backtesting)
 */
export interface TradeTick {
  asset_id: string;
  condition_id: string;
  trade_id: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  source_ts: number;
  ingestion_ts: number;
}

/**
 * Tick direction for market microstructure analysis
 */
export type TickDirection = "UP" | "DOWN" | "UNCHANGED";

/**
 * Local orderbook state maintained in Durable Object
 */
export interface LocalOrderbook {
  asset_id: string;
  condition_id: string;
  bids: Map<number, number>; // price -> size
  asks: Map<number, number>; // price -> size
  tick_size: number;
  last_hash: string;
  last_update_ts: number;
  sequence: number;
}

/**
 * Enhanced snapshot with gap detection and HFT fields
 * Follows CCXT/Nautilus Trader patterns for professional trading
 */
export interface EnhancedOrderbookSnapshot {
  asset_id: string;
  token_id: string;
  condition_id: string;
  source_ts: number; // Polymarket's timestamp (microseconds for HFT precision)
  ingestion_ts: number; // Our receipt timestamp (microseconds for precision)
  book_hash: string; // For gap detection
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
  spread_bps: number | null;
  tick_size: number;
  is_resync: boolean; // True if from gap backfill
  sequence_number: number;

  // HFT fields - market microstructure
  tick_direction?: TickDirection; // Price movement vs previous tick
  crossed?: boolean; // True if bid >= ask (error condition)

  // Depth metrics (pre-computed for speed)
  bid_depth_5?: number; // Sum of top 5 bid sizes
  ask_depth_5?: number; // Sum of top 5 ask sizes
  bid_depth_10?: number; // Sum of top 10 bid sizes
  ask_depth_10?: number; // Sum of top 10 ask sizes
  total_bid_depth?: number; // Total bid book depth
  total_ask_depth?: number; // Total ask book depth

  // Polymarket-specific
  outcome?: "YES" | "NO"; // Which outcome this orderbook represents
  neg_risk?: boolean; // Negative risk market flag
  order_min_size?: number; // Minimum order size for this market

  // ISO 8601 datetime for CCXT compatibility
  datetime?: string;
}

/**
 * BBO (Best Bid/Offer) snapshot - lightweight alternative to full L2
 * Reduces data volume by ~20-50x while preserving essential price info
 * Use this for high-frequency tick storage
 */
export interface BBOSnapshot {
  asset_id: string;
  token_id: string;
  condition_id: string;
  source_ts: number;
  ingestion_ts: number;
  book_hash: string;

  // Top-of-book only (instead of full L2 arrays)
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;  // Size at best bid
  ask_size: number | null;  // Size at best ask
  mid_price: number | null;
  spread_bps: number | null;

  tick_size: number;
  is_resync: boolean;
  sequence_number: number;
  neg_risk?: boolean;
  order_min_size?: number;
}

/**
 * Order book level change - tracks order placements, cancellations, and updates
 * Captures the delta when a price level changes in the order book
 */
export type LevelChangeType = "ADD" | "REMOVE" | "UPDATE";

export interface OrderbookLevelChange {
  asset_id: string;
  condition_id: string;
  source_ts: number;
  ingestion_ts: number;
  side: "BUY" | "SELL";
  price: number;
  old_size: number;      // Previous size at this level (0 if new level)
  new_size: number;      // New size at this level (0 if removed)
  size_delta: number;    // new_size - old_size (positive = added, negative = removed)
  change_type: LevelChangeType;
  book_hash: string;
  sequence_number: number;
}

/**
 * Full L2 snapshot for periodic deep orderbook capture
 * Stored every 5 minutes to preserve depth data while minimizing storage
 */
export interface FullL2Snapshot {
  asset_id: string;
  token_id: string;
  condition_id: string;
  source_ts: number;
  ingestion_ts: number;
  book_hash: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  tick_size: number;
  sequence_number: number;
  neg_risk?: boolean;
  order_min_size?: number;
}

/**
 * Gap backfill job for recovery queue
 */
export interface GapBackfillJob {
  asset_id: string;
  last_known_hash: string;
  gap_detected_at: number;
  retry_count: number;
}

/**
 * Hash chain state stored in KV
 */
export interface HashChainState {
  hash: string;
  timestamp: number;
  sequence: number;
}

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

/**
 * Realtime tick for trigger-based alerts (24h TTL)
 * HFT-grade: includes tick direction, crossed detection, sequence
 */
export interface RealtimeTick {
  asset_id: string;
  source_ts: number; // Microseconds
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread_bps: number | null;
  tick_direction: TickDirection;
  crossed: boolean; // True if bid >= ask (error condition)
  book_hash: string;
  sequence_number: number;
  ingestion_ts: number; // Microseconds
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
