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
