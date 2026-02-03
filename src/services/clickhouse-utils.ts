// src/services/clickhouse-utils.ts
// Shared ClickHouse utilities: error classification and reliable inserts

import { buildAsyncInsertUrl, buildClickHouseHeaders } from "./clickhouse-client";

export type ErrorSeverity = "transient" | "rate_limit" | "client_error" | "permanent";

export interface ClassifiedError {
  severity: ErrorSeverity;
  shouldRetry: boolean;
  backoffMs?: number;
  message: string;
}

// Backwards compatibility alias
export type ErrorType = ErrorSeverity;

/**
 * Classify an error from ClickHouse or general exceptions
 */
export function classifyError(error: unknown): ErrorType {
  const msg = String(error);

  if (msg.includes("timeout") || msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") || msg.includes("socket hang up") ||
      msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return "transient";
  }

  if (msg.includes("429") || msg.includes("Too Many") || msg.includes("quota")) {
    return "rate_limit";
  }

  if (msg.includes("Unknown identifier") || msg.includes("UNKNOWN_TABLE") ||
      msg.includes("Type mismatch") || msg.includes("Cannot parse") ||
      msg.includes("doesn't exist") || msg.includes("400 Bad Request")) {
    return "client_error";
  }

  return "transient";
}

/**
 * Classify HTTP response status
 */
export function classifyHttpError(status: number, body?: string): ClassifiedError {
  if (status >= 200 && status < 300) {
    return { severity: "transient", shouldRetry: false, message: "Success" };
  }
  if (status === 404) {
    return { severity: "permanent", shouldRetry: false, message: body || "Not found" };
  }
  if (status === 429) {
    return { severity: "rate_limit", shouldRetry: true, backoffMs: 60000, message: body || "Rate limited" };
  }
  if (status >= 400 && status < 500) {
    return { severity: "client_error", shouldRetry: false, message: body || `Client error: ${status}` };
  }
  if (status >= 500) {
    return { severity: "transient", shouldRetry: true, backoffMs: status === 503 ? 30000 : 5000, message: body || `Server error: ${status}` };
  }
  return { severity: "transient", shouldRetry: true, backoffMs: 5000, message: body || `Unknown: ${status}` };
}

/**
 * Classify ClickHouse-specific error
 */
export function classifyClickHouseError(error: unknown): ClassifiedError {
  const severity = classifyError(error);
  return {
    severity,
    shouldRetry: severity !== "client_error" && severity !== "permanent",
    backoffMs: severity === "rate_limit" ? 30000 : severity === "transient" ? 5000 : undefined,
    message: String(error),
  };
}

export interface InsertResult {
  success: boolean;
  shouldRetry: boolean;
  error?: string;
}

/**
 * Execute a ClickHouse insert with error classification
 */
export async function executeInsert(
  url: string,
  headers: HeadersInit,
  body: string
): Promise<InsertResult> {
  try {
    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text();
      const classified = classifyHttpError(response.status, text);
      return { success: false, shouldRetry: classified.shouldRetry, error: classified.message };
    }
    return { success: true, shouldRetry: false };
  } catch (err) {
    const classified = classifyClickHouseError(err);
    return { success: false, shouldRetry: classified.shouldRetry, error: classified.message };
  }
}

/**
 * Insert rows helper
 */
export async function insertRows<T>(
  env: { CLICKHOUSE_URL: string; CLICKHOUSE_USER: string; CLICKHOUSE_TOKEN: string },
  table: string,
  rows: T[]
): Promise<InsertResult> {
  if (rows.length === 0) return { success: true, shouldRetry: false };
  const body = rows.map(r => JSON.stringify(r)).join("\n");
  return executeInsert(
    buildAsyncInsertUrl(env.CLICKHOUSE_URL, table),
    buildClickHouseHeaders(env.CLICKHOUSE_USER, env.CLICKHOUSE_TOKEN),
    body
  );
}

/**
 * Handle batch result with ack/retry
 */
export function handleBatchResult<T>(
  messages: readonly Message<T>[],
  result: InsertResult,
  logPrefix: string
): void {
  if (result.success) {
    for (const msg of messages) msg.ack();
    return;
  }

  if (result.shouldRetry) {
    console.error(`[${logPrefix}] Insert failed (retry):`, result.error);
    for (const msg of messages) msg.retry();
  } else {
    console.error(`[${logPrefix}] Insert failed (permanent):`, result.error);
    for (const msg of messages) msg.ack();
  }
}
