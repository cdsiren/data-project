// src/services/clickhouse-client.ts
// Shared ClickHouse HTTP client utilities with async insert support

import { DB_CONFIG } from "../config/database";

/**
 * Build a ClickHouse INSERT URL with async insert parameters.
 *
 * Configuration optimized for high-throughput with reliability:
 * - wait_for_async_insert=0: Non-blocking (2-5x throughput improvement)
 * - 30s timeout: Larger batches = fewer merges
 * - 10MB buffer: Optimal batch size for MergeTree
 */
export function buildAsyncInsertUrl(baseUrl: string, table: string): string {
  const params = new URLSearchParams({
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "0",
    async_insert_busy_timeout_ms: "30000",
    async_insert_max_data_size: "10485760",
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
