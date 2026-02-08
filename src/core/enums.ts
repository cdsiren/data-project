// src/core/enums.ts
// Core enums for the trading data framework

// ============================================================
// BRANDED TYPES
// These prevent mixing different ID types at compile time
// See: https://egghead.io/blog/using-branded-types-in-typescript
// ============================================================

/**
 * Brand symbol for type branding
 */
declare const __brand: unique symbol;
type Brand<T, TBrand extends string> = T & { [__brand]: TBrand };

/**
 * Asset ID - unique identifier for a tradable asset (token_id, ticker, pool address)
 * Example: "21742633143463906290569050155826241533067272736897614950488156847949938836455" (Polymarket)
 */
export type AssetId = Brand<string, "AssetId">;

/**
 * Condition ID - market grouping identifier (groups YES/NO tokens)
 * Example: "0x123abc..." (Polymarket condition_id)
 */
export type ConditionId = Brand<string, "ConditionId">;

/**
 * Trigger ID - unique identifier for a registered trigger
 * Examples: "trig_123456_abc", "global_spread_wide"
 */
export type TriggerId = Brand<string, "TriggerId">;

/**
 * Helper functions to create branded IDs
 */
export function asAssetId(id: string): AssetId {
  return id as AssetId;
}

export function asConditionId(id: string): ConditionId {
  return id as ConditionId;
}

export function asTriggerId(id: string): TriggerId {
  return id as TriggerId;
}

// ============================================================
// MARKET ENUMS
// ============================================================

/**
 * Supported market sources.
 * To add a new market, extend this union type and implement the adapter.
 */
export type MarketSource = "polymarket";

/**
 * Market categories.
 * Currently only "prediction" is supported (Polymarket).
 * Future categories may include: "dex", "spot", "futures"
 */
export type MarketType = "prediction";

/**
 * Order side (consistent across all markets)
 */
export type OrderSide = "BUY" | "SELL";

/**
 * Tick direction for market microstructure analysis
 */
export type TickDirection = "UP" | "DOWN" | "UNCHANGED";

/**
 * Order book level change types
 */
export type LevelChangeType = "ADD" | "REMOVE" | "UPDATE";
