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
// Re-export from core/triggers.ts (canonical source)
// ============================================================
export type {
  TriggerType,
  TriggerCondition,
  Trigger,
  TriggerEvent,
  TriggerRegistration,
  PriceHistoryEntry,
} from "../core/triggers";
