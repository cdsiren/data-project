// src/services/clickhouse-client.ts
// Shared ClickHouse HTTP client utilities with async insert support

import { DB_CONFIG } from "../config/database";

/**
 * Centralized async insert configuration for maintainability.
 * Adjust these values to tune latency vs throughput trade-offs.
 */
export const ASYNC_INSERT_CONFIG = {
  /** Cost-optimized profile: maximize batching for significant merge reduction */
  COST_OPTIMIZED: {
    busy_timeout_ms: 120000,   // 120s - larger batches for 10-15% CPU savings
    stale_timeout_ms: 120000,  // 120s - accumulate larger batches
  },
  /** Batch-optimized profile: maximize batching for bulk operations */
  BATCH_OPTIMIZED: {
    busy_timeout_ms: 120000,   // 120s - larger batches for efficiency
    stale_timeout_ms: 120000,  // 120s - reduce part creation
  },
  /** Maximum data size per async insert batch */
  max_data_size: 104857600,    // 100MB - fewer parts, less merge overhead
} as const;

/**
 * Build a ClickHouse INSERT URL with async insert parameters.
 * Uses COST_OPTIMIZED profile for real-time data ingestion with reduced merge overhead.
 */
export function buildAsyncInsertUrl(baseUrl: string, table: string): string {
  const params = new URLSearchParams({
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "1", // Guarantee durability before returning
    async_insert_busy_timeout_ms: String(ASYNC_INSERT_CONFIG.COST_OPTIMIZED.busy_timeout_ms),
    async_insert_max_data_size: String(ASYNC_INSERT_CONFIG.max_data_size),
    async_insert_stale_timeout_ms: String(ASYNC_INSERT_CONFIG.COST_OPTIMIZED.stale_timeout_ms),
  });
  return `${baseUrl}/?${params.toString()}`;
}

/**
 * Build a ClickHouse INSERT URL with async insert and explicit columns.
 * Uses BATCH_OPTIMIZED profile for bulk operations.
 */
export function buildAsyncInsertUrlWithColumns(
  baseUrl: string,
  table: string,
  columns: string[]
): string {
  const params = new URLSearchParams({
    database: DB_CONFIG.DATABASE,
    query: `INSERT INTO ${DB_CONFIG.DATABASE}.${table} (${columns.join(", ")}) FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "1", // Guarantee durability before returning
    async_insert_busy_timeout_ms: String(ASYNC_INSERT_CONFIG.BATCH_OPTIMIZED.busy_timeout_ms),
  });
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Build a ClickHouse INSERT URL with synchronous confirmation.
 * Uses async_insert with wait_for_async_insert=1 for guaranteed persistence.
 *
 * Use this for CRITICAL tables where data loss is unacceptable:
 * - market_metadata (required for dashboard queries)
 * - market_events
 *
 * Trade-off: Slightly higher latency (~100-500ms) but guaranteed durability.
 */
export function buildSyncInsertUrlWithColumns(
  baseUrl: string,
  table: string,
  columns: string[]
): string {
  const params = new URLSearchParams({
    database: DB_CONFIG.DATABASE,
    query: `INSERT INTO ${DB_CONFIG.DATABASE}.${table} (${columns.join(", ")}) FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "1", // CRITICAL: Wait for insert confirmation
    async_insert_busy_timeout_ms: String(ASYNC_INSERT_CONFIG.BATCH_OPTIMIZED.busy_timeout_ms),
    async_insert_max_data_size: String(ASYNC_INSERT_CONFIG.max_data_size),
    async_insert_stale_timeout_ms: String(ASYNC_INSERT_CONFIG.BATCH_OPTIMIZED.stale_timeout_ms),
  });
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Standard headers for ClickHouse HTTP requests.
 */
export function buildClickHouseHeaders(user: string, token: string): HeadersInit {
  return {
    "X-ClickHouse-User": user,
    "X-ClickHouse-Key": token,
    "Content-Type": "text/plain",
  };
}
