// src/config/database.ts
// Centralized database configuration for multi-market support
// Follows Nautilus Trader (Venue + AssetClass) and CCXT (type) patterns

import type { MarketSource, MarketType } from "../core/enums";
import type { ArchiveType } from "../schemas/common";

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

// ============================================================
// Archive Configuration
// ============================================================

/**
 * Raw Polymarket database configuration (subgraph data)
 */
export const RAW_POLYMARKET_DB = {
  DATABASE: "raw_polymarket",
  TABLES: {
    GLOBAL_OPEN_INTEREST: "global_open_interest",
    MARKET_OPEN_INTEREST: "market_open_interest",
    ORDER_FILLED: "order_filled",
    ORDERS_MATCHED: "orders_matched",
    USER_POSITIONS: "user_positions",
  },
} as const;

/**
 * Archive trigger types for each table
 */
export type ArchiveTrigger = "resolved" | "aged" | "block_range";

/**
 * Archive table configuration
 */
export interface ArchiveTableConfig {
  database: string;
  table: string;
  trigger: ArchiveTrigger;
  keyColumn: string; // Primary time/identifier column for archive queries
  keyColumnType?: "datetime" | "string"; // Column type for proper comparison (default: datetime)
  conditionIdColumn?: string; // For resolved market triggers
}

/**
 * Registry of all tables to be archived with their configurations
 */
export const ARCHIVE_TABLE_REGISTRY: ArchiveTableConfig[] = [
  // Trading data - market-specific tables (resolved OR aged)
  {
    database: "trading_data",
    table: "ob_bbo",
    trigger: "resolved",
    keyColumn: "source_ts",
    conditionIdColumn: "condition_id",
  },
  {
    database: "trading_data",
    table: "ob_snapshots",
    trigger: "resolved",
    keyColumn: "source_ts",
    conditionIdColumn: "condition_id",
  },
  {
    database: "trading_data",
    table: "trade_ticks",
    trigger: "resolved",
    keyColumn: "source_ts",
    conditionIdColumn: "condition_id",
  },
  {
    database: "trading_data",
    table: "ob_level_changes",
    trigger: "resolved",
    keyColumn: "source_ts",
    conditionIdColumn: "condition_id",
  },
  // Trading data - operational tables (aged only)
  {
    database: "trading_data",
    table: "trades",
    trigger: "aged",
    keyColumn: "timestamp",
  },
  {
    database: "trading_data",
    table: "makers",
    trigger: "aged",
    keyColumn: "timestamp",
  },
  {
    database: "trading_data",
    table: "takers",
    trigger: "aged",
    keyColumn: "timestamp",
  },
  {
    database: "trading_data",
    table: "markets",
    trigger: "aged",
    keyColumn: "timestamp",
  },
  {
    database: "trading_data",
    table: "ob_gap_events",
    trigger: "aged",
    keyColumn: "detected_at",
  },
  {
    database: "trading_data",
    table: "dead_letter_messages",
    trigger: "aged",
    keyColumn: "failed_at",
  },
  {
    database: "trading_data",
    table: "ob_latency",
    trigger: "aged",
    keyColumn: "source_ts",
  },
  {
    database: "trading_data",
    table: "market_metadata",
    trigger: "aged",
    keyColumn: "created_at",
  },
  {
    database: "trading_data",
    table: "market_events",
    trigger: "aged",
    keyColumn: "inserted_at",
  },
  // Raw Polymarket - block_range tables
  {
    database: "raw_polymarket",
    table: "global_open_interest",
    trigger: "block_range",
    keyColumn: "block_range",
  },
  {
    database: "raw_polymarket",
    table: "market_open_interest",
    trigger: "block_range",
    keyColumn: "block_range",
  },
  {
    database: "raw_polymarket",
    table: "user_positions",
    trigger: "block_range",
    keyColumn: "block_range",
  },
  // Raw Polymarket - timestamp tables (String type timestamps from subgraph)
  {
    database: "raw_polymarket",
    table: "order_filled",
    trigger: "aged",
    keyColumn: "timestamp",
    keyColumnType: "string", // Subgraph stores timestamps as Unix epoch strings
  },
  {
    database: "raw_polymarket",
    table: "orders_matched",
    trigger: "aged",
    keyColumn: "timestamp",
    keyColumnType: "string", // Subgraph stores timestamps as Unix epoch strings
  },
];

/**
 * Get tables for a specific archive trigger type
 */
export function getTablesForTrigger(trigger: ArchiveTrigger): ArchiveTableConfig[] {
  return ARCHIVE_TABLE_REGISTRY.filter((t) => t.trigger === trigger);
}

/**
 * Get tables that support resolved market archiving (have condition_id)
 */
export function getResolvedMarketTables(): ArchiveTableConfig[] {
  return ARCHIVE_TABLE_REGISTRY.filter((t) => t.conditionIdColumn !== undefined);
}

// ============================================================
// Block Range Utilities (for raw_polymarket tables)
// ============================================================

/**
 * Parse a Graph Node block_range string
 * Format: "[start,end)" or "[start,)" for open-ended ranges
 */
export function parseBlockRange(blockRange: string): { start: number; end: number | null } {
  const match = blockRange.match(/\[(\d+),(\d*)\)/);
  if (!match) {
    return { start: 0, end: null };
  }
  return {
    start: parseInt(match[1], 10),
    end: match[2] ? parseInt(match[2], 10) : null,
  };
}

/**
 * Calculate block cutoff for 90-day archival
 * Polygon produces ~1 block every 2 seconds
 * 90 days = 90 * 24 * 60 * 60 / 2 = 3,888,000 blocks
 */
export function calculateBlockCutoff(currentBlock: number, days: number = 90): number {
  const blocksPerSecond = 0.5; // ~1 block per 2 seconds on Polygon
  const secondsPerDay = 24 * 60 * 60;
  const blocksInPeriod = Math.floor(days * secondsPerDay * blocksPerSecond);
  return currentBlock - blocksInPeriod;
}

// ============================================================
// Archive Path Utilities
// ============================================================

/**
 * R2 bucket structure constants
 */
export const R2_PATHS = {
  TRADING_DATA_RESOLVED: "trading_data/resolved",
  TRADING_DATA_AGED: "trading_data/aged",
  TRADING_DATA_OPERATIONAL: "trading_data/operational",
  RAW_POLYMARKET: "raw_polymarket",
  MANIFESTS: "manifests",
} as const;

/**
 * Generate R2 path for archived data
 */
export function getArchivePath(
  database: string,
  table: string,
  archiveType: ArchiveType,
  options: {
    conditionId?: string;
    month?: string; // YYYY-MM format
  }
): string {
  const { conditionId, month } = options;

  if (database === "trading_data") {
    if (archiveType === "resolved" && conditionId) {
      // trading_data/resolved/{condition_id}/{table}/{YYYY-MM}/data.parquet
      return `${R2_PATHS.TRADING_DATA_RESOLVED}/${conditionId}/${table}/${month || "unknown"}/data.parquet`;
    }
    // Operational tables
    if (["ob_gap_events", "dead_letter_messages"].includes(table)) {
      return `${R2_PATHS.TRADING_DATA_OPERATIONAL}/${table}/${month || "unknown"}/data.parquet`;
    }
    // Aged data
    return `${R2_PATHS.TRADING_DATA_AGED}/${table}/${month || "unknown"}/data.parquet`;
  }

  if (database === "raw_polymarket") {
    return `${R2_PATHS.RAW_POLYMARKET}/${table}/${month || "unknown"}/data.parquet`;
  }

  // Fallback
  return `${database}/${table}/${month || "unknown"}/data.parquet`;
}

/**
 * Generate manifest path for a table
 */
export function getManifestPath(database: string, table: string): string {
  return `${R2_PATHS.MANIFESTS}/${database}_${table}.json`;
}
