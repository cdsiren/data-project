// src/config/database.ts
// Centralized database configuration for multi-market support
// Follows Nautilus Trader (Venue + AssetClass) and CCXT (type) patterns

import type { MarketSource, MarketType } from "../core/enums";

/**
 * Mapping from market source to market type
 * Following CCXT's market.type pattern
 */
export const MARKET_SOURCE_TO_TYPE: Record<MarketSource, MarketType> = {
  polymarket: "prediction",
  kalshi: "prediction",
  uniswap: "dex",
  binance: "cex",
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
    // Materialized views
    MV_BBO_1M: "mv_ob_bbo_1m",
    MV_BBO_5M: "mv_ob_bbo_5m",
    MV_HOURLY_STATS: "mv_ob_hourly_stats",
    MV_LATENCY_HOURLY: "mv_ob_latency_hourly",
    // Helper views
    V_BBO_1M: "v_ob_bbo_1m",
    V_BBO_5M: "v_ob_bbo_5m",
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
 * Check if a market source is valid
 */
export function isValidMarketSource(source: string): source is MarketSource {
  const validSources: MarketSource[] = ["polymarket", "kalshi", "uniswap", "binance"];
  return validSources.includes(source as MarketSource);
}

/**
 * Check if a market type is valid
 */
export function isValidMarketType(type: string): type is MarketType {
  const validTypes: MarketType[] = ["prediction", "dex", "cex"];
  return validTypes.includes(type as MarketType);
}
