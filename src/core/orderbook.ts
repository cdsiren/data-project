// src/core/orderbook.ts
// Market-agnostic orderbook types for the multi-market trading framework
// These types are used across all markets after normalization from market-specific formats

import type { MarketSource, OrderSide, TickDirection, LevelChangeType } from "./enums";

/**
 * BBO (Best Bid/Offer) snapshot - lightweight top-of-book data
 * This is the primary type for high-frequency tick storage
 * Reduces data volume by ~20-50x compared to full L2
 */
export interface BBOSnapshot {
  // Market identification
  market_source: MarketSource;
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
  asset_id: string;           // Native market ID (token_id, ticker, etc.)
  token_id: string;           // For display/lookup
  condition_id: string;       // Market grouping ID (condition_id, series_ticker, pool_address)

  // Timestamps
  source_ts: number;          // Source timestamp (microseconds)
  ingestion_ts: number;       // Ingestion timestamp (microseconds)

  // Gap detection
  book_hash: string;
  sequence_number: number;
  is_resync: boolean;         // True if from gap backfill

  // Top-of-book pricing
  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid_price: number | null;
  spread_bps: number | null;

  // Market parameters
  tick_size: number;

  // Market-specific extensions (optional)
  neg_risk?: boolean;         // Polymarket: negative risk flag
  order_min_size?: number;    // Minimum order size
}

/**
 * Trade tick for execution-level data
 * Critical for backtesting and market microstructure analysis
 */
export interface TradeTick {
  market_source: MarketSource;
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
  asset_id: string;
  condition_id: string;
  trade_id: string;
  price: number;
  size: number;
  side: OrderSide;
  source_ts: number;          // Microseconds
  ingestion_ts: number;       // Microseconds
}

/**
 * Order book level change - tracks order placements, cancellations, updates
 * Captures deltas when a price level changes
 */
export interface OrderbookLevelChange {
  market_source: MarketSource;
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
  asset_id: string;
  condition_id: string;
  source_ts: number;
  ingestion_ts: number;
  side: OrderSide;
  price: number;
  old_size: number;           // Previous size (0 if new level)
  new_size: number;           // New size (0 if removed)
  size_delta: number;         // new_size - old_size
  change_type: LevelChangeType;
  book_hash: string;
  sequence_number: number;
}

/**
 * Full L2 snapshot for periodic deep orderbook capture
 * Stored every 5 minutes to preserve depth data while minimizing storage
 */
export interface FullL2Snapshot {
  market_source: MarketSource;
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
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
 * Local orderbook state maintained in Durable Object
 * In-memory representation for real-time processing
 */
export interface LocalOrderbook {
  market_source: MarketSource;
  asset_id: string;
  condition_id: string;
  bids: Map<number, number>;  // price -> size
  asks: Map<number, number>;  // price -> size
  tick_size: number;
  last_hash: string;
  last_update_ts: number;
  sequence: number;
}

/**
 * Gap backfill job for recovery queue
 */
export interface GapBackfillJob {
  market_source: MarketSource | string; // Allow string for flexibility but prefer MarketSource
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
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
 * Realtime tick for trigger-based alerts (24h TTL)
 * HFT-grade: includes tick direction, crossed detection, sequence
 */
export interface RealtimeTick {
  market_source: MarketSource;
  market_type?: string;       // Market category (prediction, dex, cex) - optional for backward compatibility
  asset_id: string;
  source_ts: number;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread_bps: number | null;
  tick_direction: TickDirection;
  crossed: boolean;           // True if bid >= ask (error condition)
  book_hash: string;
  sequence_number: number;
  ingestion_ts: number;
}

/**
 * Enhanced orderbook snapshot with HFT fields
 * Used for detailed market microstructure analysis
 */
export interface EnhancedOrderbookSnapshot extends BBOSnapshot {
  // Full depth arrays
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;

  // HFT fields - market microstructure
  tick_direction?: TickDirection;
  crossed?: boolean;

  // Depth metrics (pre-computed for speed)
  bid_depth_5?: number;
  ask_depth_5?: number;
  bid_depth_10?: number;
  ask_depth_10?: number;
  total_bid_depth?: number;
  total_ask_depth?: number;

  // Prediction market specific
  outcome?: "YES" | "NO";

  // ISO 8601 datetime for CCXT compatibility
  datetime?: string;
}
