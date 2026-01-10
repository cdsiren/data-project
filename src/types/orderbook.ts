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
 */
export interface OrderbookLevel {
  price: number;
  size: number;
}

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
 * Enhanced snapshot with gap detection fields
 * Extends your existing OrderbookSnapshot
 */
export interface EnhancedOrderbookSnapshot {
  asset_id: string;
  token_id: string;
  condition_id: string;
  source_ts: number; // Polymarket's timestamp (ms)
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
