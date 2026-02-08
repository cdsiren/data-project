// src/config/database.ts
// Centralized database configuration for multi-market support
// Follows Nautilus Trader (Venue + AssetClass) and CCXT (type) patterns

import type { MarketSource, MarketType } from "../core/enums";

/**
 * Mapping from market source to market type.
 * Add new markets here when implementing additional adapters.
 */
export const MARKET_SOURCE_TO_TYPE: Record<MarketSource, MarketType> = {
  polymarket: "prediction",
} as const;

export const DB_CONFIG = {
  // Database name changed from "polymarket" to "trading_data" for multi-market support
  DATABASE: "trading_data",
  // Default market source for backward compatibility
  DEFAULT_MARKET_SOURCE: "polymarket" as MarketSource,
  // Default market type for backward compatibility
  DEFAULT_MARKET_TYPE: "prediction" as MarketType,
  TABLES: {
    TRADE_TICKS: "trade_ticks",
    OB_LATENCY: "ob_latency",
    OB_GAP_EVENTS: "ob_gap_events",
    OB_SNAPSHOTS: "ob_snapshots",
    OB_BBO: "ob_bbo",
    OB_LEVEL_CHANGES: "ob_level_changes",
    DEAD_LETTER: "dead_letter_messages",
    USAGE_EVENTS: "usage_events",
    // Materialized views (operational)
    MV_HOURLY_STATS: "mv_ob_hourly_stats",
    MV_LATENCY_HOURLY: "mv_ob_latency_hourly",
  },
} as const;

export type TableName = keyof typeof DB_CONFIG.TABLES;

/**
 * Get full table name with database prefix
 */
export function getFullTableName(table: TableName): string {
  return `${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES[table]}`;
}

/**
 * Get the default market source for backward compatibility
 */
export function getDefaultMarketSource(): MarketSource {
  return DB_CONFIG.DEFAULT_MARKET_SOURCE;
}

/**
 * Get the default market type for backward compatibility
 */
export function getDefaultMarketType(): MarketType {
  return DB_CONFIG.DEFAULT_MARKET_TYPE;
}

/**
 * Get the market type for a given market source
 * Following CCXT's market.type pattern
 */
export function getMarketType(source: MarketSource): MarketType {
  return MARKET_SOURCE_TO_TYPE[source];
}

/**
 * Valid market types supported by the system.
 * Currently only "prediction" is active.
 */
const VALID_MARKET_TYPES: readonly MarketType[] = [
  "prediction",
] as const;

/**
 * Check if a market source is valid
 */
export function isValidMarketSource(source: string): source is MarketSource {
  return source in MARKET_SOURCE_TO_TYPE;
}

function isValidMarketType(type: string): type is MarketType {
  return VALID_MARKET_TYPES.includes(type as MarketType);
}

/**
 * Normalized market info result
 */
export interface NormalizedMarketInfo {
  source: MarketSource;
  type: MarketType;
}

/**
 * Normalize market source and type in a single call.
 * Eliminates duplicate defaulting logic across consumers.
 *
 * @param marketSource - Optional market source from message
 * @param marketType - Optional market type from message
 * @returns Normalized source and type with defaults applied
 */
export function normalizeMarketInfo(
  marketSource?: string,
  marketType?: string
): NormalizedMarketInfo {
  // Validate and default market source
  const source: MarketSource = (marketSource && isValidMarketSource(marketSource))
    ? marketSource
    : getDefaultMarketSource();

  // Validate and default market type (derives from source if not provided)
  const type: MarketType = (marketType && isValidMarketType(marketType))
    ? marketType
    : getMarketType(source);

  return { source, type };
}

/**
 * Get batch defaults for market info (computed once per batch).
 * Use this at the start of a consumer batch to avoid repeated function calls.
 */
export function getBatchMarketDefaults(): NormalizedMarketInfo {
  return {
    source: getDefaultMarketSource(),
    type: getDefaultMarketType(),
  };
}
