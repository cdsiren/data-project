// src/services/clickhouse-client.ts
// Shared ClickHouse HTTP client utilities with async insert support

import { DB_CONFIG } from "../config/database";

/**
 * Build a ClickHouse INSERT URL with async insert parameters.
 *
 * Async inserts buffer data server-side before flushing to disk,
 * reducing CPU load from frequent small inserts (same benefit as Buffer tables)
 * but with better reliability (acknowledged writes, no in-memory data loss risk).
 *
 * @param baseUrl - ClickHouse HTTP endpoint (e.g., https://host:8443)
 * @param table - Full table name (e.g., polymarket.ob_bbo)
 * @returns URL with query and async insert parameters
 */
export function buildAsyncInsertUrl(baseUrl: string, table: string): string {
  const params = new URLSearchParams({
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "1",
    async_insert_busy_timeout_ms: "10000", // 10s flush interval for aggressive batching
  });
  return `${baseUrl}/?${params.toString()}`;
}

/**
 * Build a ClickHouse INSERT URL with async insert and explicit columns.
 * Use this when you need to specify column order.
 *
 * @param baseUrl - ClickHouse HTTP endpoint
 * @param table - Table name (without database prefix)
 * @param columns - Array of column names
 * @returns URL with query and async insert parameters
 */
export function buildAsyncInsertUrlWithColumns(
  baseUrl: string,
  table: string,
  columns: string[]
): string {
  const columnsList = columns.join(", ");
  const params = new URLSearchParams({
    database: DB_CONFIG.DATABASE,
    query: `INSERT INTO ${DB_CONFIG.DATABASE}.${table} (${columnsList}) FORMAT JSONEachRow`,
    async_insert: "1",
    wait_for_async_insert: "1",
    async_insert_busy_timeout_ms: "10000", // 10s flush interval for aggressive batching
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
