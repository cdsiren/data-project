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
 * Local orderbook level for in-memory state
 * Uses string for price to preserve exact decimal precision (CCXT pattern)
 */
export interface OrderbookLevel {
  price: number;
  size: number;
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

  // ISO 8601 datetime for CCXT compatibility
  datetime?: string;
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
