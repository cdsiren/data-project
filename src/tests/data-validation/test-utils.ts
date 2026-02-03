/**
 * Shared utilities for ClickHouse data validation tests
 */

import { DB_CONFIG } from "../../config/database";

// API endpoints
export const CLOB_REST_URL = "https://clob.polymarket.com";
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// Test configuration
export const TEST_CONFIG = {
  // How far back to look for recent data (in hours)
  LOOKBACK_HOURS: 24,
  // Tolerance for price comparisons (as decimal, e.g., 0.0001 = 0.01%)
  PRICE_TOLERANCE: 0.0001,
  // Tolerance for spread calculations (in bps)
  SPREAD_BPS_TOLERANCE: 0.1,
  // Maximum acceptable latency (ms)
  MAX_LATENCY_MS: 60000,
  // Sample size for statistical tests
  SAMPLE_SIZE: 1000,
};

/**
 * Validation thresholds with documented rationale.
 * Centralized here to make threshold adjustments easy and consistent.
 */
export const VALIDATION_THRESHOLDS = {
  // === Temporal Integrity ===
  // Allow <3% time travel for historical data affected by timestamp unit bug (ms vs μs)
  // Some tables (trade_ticks, ob_level_changes) have higher rates due to older data
  TIME_TRAVEL_PERCENT: 3,
  // Allow <20% out-of-order within same asset (WebSocket message reordering)
  OUT_OF_ORDER_PERCENT: 20,

  // === Mathematical Consistency ===
  // Truly crossed books (bid > ask, both > 0) should be <1% - represents arbitrage moments
  CROSSED_BOOKS_PERCENT: 1,
  // Spread calculation tolerance in basis points
  SPREAD_BPS_TOLERANCE: 5,
  // Change type mismatch tolerance - level_change types may not perfectly align with size deltas
  CHANGE_TYPE_MISMATCH_PERCENT: 5,

  // === Sequence & Gap Detection ===
  // Sequence number negative jumps - allow up to 30% due to shard rebalancing and reconnections
  SEQUENCE_NEGATIVE_JUMP_PERCENT: 30,
  // Large sequence jumps (>1000) should be rare
  SEQUENCE_LARGE_JUMP_MAX: 100,
  // Assets with sequence regressions - allow some due to resyncs
  SEQUENCE_REGRESSION_ASSETS_MAX: 20,
  // Significant time gaps (>30s) as percent of consecutive pairs
  SIGNIFICANT_GAP_PERCENT: 50,
  // Hash change rate bounds - too low means stale data, too high means duplicates
  HASH_CHANGE_RATE_MIN: 0.1,
  HASH_CHANGE_RATE_MAX: 99.9,

  // === Cross-Table Consistency ===
  // Price drift vs live API - allow 50% due to timing differences
  LIVE_API_DRIFT_PERCENT: 50,
  // Orphan trades (no orderbook data) - allow some for closed markets
  ORPHAN_TRADE_MAX: 100,
  // Duplicate snapshots - should be near zero
  DUPLICATE_SNAPSHOT_MAX: 50,

  // === Data Quality ===
  // Stale pending gaps older than 1 hour
  STALE_GAP_MAX_HOURS: 1,
  // Notional calculation mismatch (price * size != notional)
  NOTIONAL_MISMATCH_PERCENT: 10,
  // Trade price vs orderbook anomalies
  TRADE_PRICE_ANOMALY_PERCENT: 5,
} as const;

export interface ClickHouseConfig {
  url: string;
  user: string;
  token: string;
}

/**
 * Get ClickHouse configuration from environment
 */
export function getClickHouseConfig(): ClickHouseConfig | null {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER || "default";
  const token = process.env.CLICKHOUSE_TOKEN;

  if (!url || !token) {
    return null;
  }

  return { url, user, token };
}

/**
 * Build headers for ClickHouse HTTP requests
 */
export function buildHeaders(config: ClickHouseConfig): HeadersInit {
  return {
    "X-ClickHouse-User": config.user,
    "X-ClickHouse-Key": config.token,
    "Content-Type": "text/plain",
  };
}

/**
 * Execute a ClickHouse query and return JSON results
 */
export async function executeQuery<T = Record<string, unknown>>(
  config: ClickHouseConfig,
  query: string
): Promise<{ data: T[]; rows: number; statistics: { elapsed: number; rows_read: number } }> {
  const encodedQuery = encodeURIComponent(`${query} FORMAT JSON`);
  const response = await fetch(`${config.url}/?query=${encodedQuery}`, {
    method: "GET",
    headers: buildHeaders(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ClickHouse query failed: ${error}`);
  }

  return response.json();
}

/**
 * Get full table name with database prefix
 */
export function getTable(table: keyof typeof DB_CONFIG.TABLES): string {
  return `${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES[table]}`;
}

/**
 * Fetch orderbook from Polymarket CLOB REST API
 */
export async function fetchLiveOrderbook(tokenId: string): Promise<{
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
} | null> {
  try {
    const response = await fetch(`${CLOB_REST_URL}/book?token_id=${tokenId}`);
    if (!response.ok) {
      console.warn(`Failed to fetch orderbook for ${tokenId}: ${response.status}`);
      return null;
    }
    return response.json();
  } catch (error) {
    console.warn(`Error fetching orderbook for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Fetch spread data from Polymarket CLOB REST API
 */
export async function fetchLiveSpreads(tokenId: string): Promise<{
  spread: number;
  mid: number;
  best_bid: number;
  best_ask: number;
} | null> {
  try {
    // Polymarket spreads endpoint returns spread info for a token
    const response = await fetch(`${CLOB_REST_URL}/spread?token_id=${tokenId}`);
    if (!response.ok) {
      // Fall back to computing from orderbook if spread endpoint unavailable
      const book = await fetchLiveOrderbook(tokenId);
      if (!book || book.bids.length === 0 || book.asks.length === 0) {
        return null;
      }
      // Polymarket returns bids ASCENDING (best last) and asks DESCENDING (best last)
      // O(1) access to last element instead of O(n) reduce
      const bestBid = book.bids.length > 0
        ? parseFloat(book.bids[book.bids.length - 1].price)
        : 0;
      const bestAsk = book.asks.length > 0
        ? parseFloat(book.asks[book.asks.length - 1].price)
        : 0;
      const mid = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;
      return { spread, mid, best_bid: bestBid, best_ask: bestAsk };
    }
    const data = await response.json();
    return {
      spread: parseFloat(data.spread || "0"),
      mid: parseFloat(data.mid || "0"),
      best_bid: parseFloat(data.bid || "0"),
      best_ask: parseFloat(data.ask || "0"),
    };
  } catch (error) {
    console.warn(`Error fetching spreads for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Fetch orderbook summary with computed metrics
 */
export async function fetchOrderbookSummary(tokenId: string): Promise<{
  token_id: string;
  best_bid: number;
  best_ask: number;
  mid_price: number;
  spread: number;
  spread_bps: number;
  total_bid_depth: number;
  total_ask_depth: number;
  bid_levels: number;
  ask_levels: number;
  hash: string;
  timestamp: string;
} | null> {
  try {
    const book = await fetchLiveOrderbook(tokenId);
    if (!book) {
      return null;
    }

    // Polymarket returns bids ASCENDING (best last) and asks DESCENDING (best last)
    // O(1) access to last element instead of O(n) reduce
    const bestBid = book.bids.length > 0
      ? parseFloat(book.bids[book.bids.length - 1].price)
      : 0;
    const bestAsk = book.asks.length > 0
      ? parseFloat(book.asks[book.asks.length - 1].price)
      : 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spread = bestAsk - bestBid;
    const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 0;

    const totalBidDepth = book.bids.reduce((sum, b) => sum + parseFloat(b.size), 0);
    const totalAskDepth = book.asks.reduce((sum, a) => sum + parseFloat(a.size), 0);

    return {
      token_id: tokenId,
      best_bid: bestBid,
      best_ask: bestAsk,
      mid_price: midPrice,
      spread,
      spread_bps: spreadBps,
      total_bid_depth: totalBidDepth,
      total_ask_depth: totalAskDepth,
      bid_levels: book.bids.length,
      ask_levels: book.asks.length,
      hash: book.hash,
      timestamp: book.timestamp,
    };
  } catch (error) {
    console.warn(`Error fetching orderbook summary for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Fetch market metadata from Gamma API
 */
export async function fetchMarketMetadata(conditionId: string): Promise<{
  id: string;
  question: string;
  conditionId: string;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  negRisk: boolean;
  clobTokenIds: string;
} | null> {
  try {
    const response = await fetch(`${GAMMA_API_URL}/markets?condition_id=${conditionId}&limit=1`);
    if (!response.ok) {
      console.warn(`Failed to fetch market metadata for ${conditionId}: ${response.status}`);
      return null;
    }
    const data = await response.json();
    return data[0] || null;
  } catch (error) {
    console.warn(`Error fetching market metadata for ${conditionId}:`, error);
    return null;
  }
}

/**
 * Check if two numbers are approximately equal within tolerance
 */
export function approxEqual(a: number, b: number, tolerance: number = TEST_CONFIG.PRICE_TOLERANCE): boolean {
  if (a === 0 && b === 0) return true;
  if (a === 0 || b === 0) return Math.abs(a - b) < tolerance;
  return Math.abs((a - b) / Math.max(Math.abs(a), Math.abs(b))) < tolerance;
}

/**
 * Format a validation result for reporting
 */
export interface ValidationResult {
  passed: boolean;
  test: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  sampleSize?: number;
}

export function formatValidationResults(results: ValidationResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  let output = `\n=== Validation Results ===\n`;
  output += `Passed: ${passed}/${results.length}\n`;
  output += `Failed: ${failed}/${results.length}\n\n`;

  for (const result of results) {
    const status = result.passed ? "✓" : "✗";
    output += `${status} ${result.test}\n`;
    if (!result.passed) {
      output += `  Message: ${result.message}\n`;
      if (result.expected !== undefined) {
        output += `  Expected: ${JSON.stringify(result.expected)}\n`;
      }
      if (result.actual !== undefined) {
        output += `  Actual: ${JSON.stringify(result.actual)}\n`;
      }
    }
    if (result.sampleSize !== undefined) {
      output += `  Sample size: ${result.sampleSize}\n`;
    }
  }

  return output;
}

/**
 * Get a sample of recent asset IDs from the database
 * Tries ob_bbo first, falls back to trade_ticks or ob_snapshots
 */
export async function getRecentAssetIds(
  config: ClickHouseConfig,
  limit: number = 10
): Promise<string[]> {
  // Try multiple tables in order of preference
  const tables = [
    getTable("OB_BBO"),
    getTable("TRADE_TICKS"),
    getTable("OB_SNAPSHOTS"),
  ];

  for (const table of tables) {
    try {
      const query = `
        SELECT asset_id, max(source_ts) as latest
        FROM ${table}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY asset_id
        ORDER BY latest DESC
        LIMIT ${limit}
      `;

      const result = await executeQuery<{ asset_id: string }>(config, query);
      if (result.data.length > 0) {
        return result.data.map((row) => row.asset_id);
      }
    } catch {
      // Try next table
    }
  }

  return [];
}

/**
 * Get a sample of recent condition IDs from the database
 * Tries ob_bbo first, falls back to trade_ticks or ob_snapshots
 */
export async function getRecentConditionIds(
  config: ClickHouseConfig,
  limit: number = 10
): Promise<string[]> {
  // Try multiple tables in order of preference
  const tables = [
    getTable("OB_BBO"),
    getTable("TRADE_TICKS"),
    getTable("OB_SNAPSHOTS"),
  ];

  for (const table of tables) {
    try {
      const query = `
        SELECT condition_id, max(source_ts) as latest
        FROM ${table}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY condition_id
        ORDER BY latest DESC
        LIMIT ${limit}
      `;

      const result = await executeQuery<{ condition_id: string }>(config, query);
      if (result.data.length > 0) {
        return result.data.map((row) => row.condition_id);
      }
    } catch {
      // Try next table
    }
  }

  return [];
}
