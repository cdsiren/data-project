// src/services/clickhouse-client.ts
// Shared ClickHouse HTTP client utilities with async insert support

import { DB_CONFIG } from "../config/database";

/**
 * Build a ClickHouse INSERT URL with async insert parameters.
 *
 * Configuration optimized for high-throughput with cost efficiency:
 * - wait_for_async_insert=0: Non-blocking (2-5x throughput improvement)
 * - 60s timeout: Accumulate larger batches for fewer merge operations (30-40% reduction)
 * - 50MB buffer: Larger batches = fewer merge operations
 * - 30s stale timeout: Flush after 30s even if buffer not full (data freshness)
 */
export function buildAsyncInsertUrl(baseUrl: string, table: string): string {
  const params = new URLSearchParams({
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "0",
    async_insert_busy_timeout_ms: "60000",      // 60s - accumulate larger batches
    async_insert_max_data_size: "52428800",     // 50MB - reduce merge operations
    async_insert_stale_timeout_ms: "30000",     // 30s - flush even if not full
  });
  return `${baseUrl}/?${params.toString()}`;
}

/**
 * Build a ClickHouse INSERT URL with async insert and explicit columns.
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
    wait_for_async_insert: "0",
    async_insert_busy_timeout_ms: "30000",
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
