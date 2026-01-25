// src/services/clickhouse-utils.ts
// Shared ClickHouse utilities: circuit breaker, error classification, and reliable inserts

import { buildAsyncInsertUrl, buildClickHouseHeaders } from "./clickhouse-client";

// ============================================================
// ERROR CLASSIFICATION
// ============================================================

/**
 * Error severity levels for unified error handling
 */
export type ErrorSeverity = "transient" | "rate_limit" | "client_error" | "permanent";

/**
 * Classified error with metadata for consistent handling
 */
export interface ClassifiedError {
  severity: ErrorSeverity;
  shouldRetry: boolean;
  backoffMs?: number;
  message: string;
}

// Backwards compatibility alias
export type ErrorType = ErrorSeverity;

/**
 * Classify an error from ClickHouse or general exceptions.
 * Used by consumers to determine retry behavior.
 */
export function classifyError(error: unknown): ErrorType {
  const msg = String(error);

  // Network/timeout errors - transient
  if (msg.includes("timeout") || msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") || msg.includes("socket hang up") ||
      msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return "transient";
  }

  // Rate limiting
  if (msg.includes("429") || msg.includes("Too Many") || msg.includes("quota")) {
    return "rate_limit";
  }

  // Schema/validation errors - don't retry
  if (msg.includes("Unknown identifier") || msg.includes("UNKNOWN_TABLE") ||
      msg.includes("Type mismatch") || msg.includes("Cannot parse") ||
      msg.includes("doesn't exist") || msg.includes("400 Bad Request")) {
    return "client_error";
  }

  return "transient"; // Default to transient for safety
}

/**
 * Classify an HTTP response status code for consistent error handling.
 * Used across all HTTP-based consumers and services.
 *
 * @param status - HTTP status code
 * @param body - Optional response body for additional context
 * @returns Classified error with retry guidance
 */
export function classifyHttpError(status: number, body?: string): ClassifiedError {
  // Success - not an error
  if (status >= 200 && status < 300) {
    return {
      severity: "transient", // Should not happen, but safe default
      shouldRetry: false,
      message: "Success",
    };
  }

  // 404 - Resource not found (expected for resolved markets)
  if (status === 404) {
    return {
      severity: "permanent",
      shouldRetry: false,
      message: body || "Resource not found",
    };
  }

  // 429 - Rate limited
  if (status === 429) {
    return {
      severity: "rate_limit",
      shouldRetry: true,
      backoffMs: 60000, // 1 minute default
      message: body || "Rate limited",
    };
  }

  // 4xx Client errors (except 404, 429) - don't retry
  if (status >= 400 && status < 500) {
    return {
      severity: "client_error",
      shouldRetry: false,
      message: body || `Client error: ${status}`,
    };
  }

  // 5xx Server errors - retry with backoff
  if (status >= 500) {
    return {
      severity: "transient",
      shouldRetry: true,
      backoffMs: status === 503 ? 30000 : 5000, // Longer backoff for 503
      message: body || `Server error: ${status}`,
    };
  }

  // Unknown status - treat as transient
  return {
    severity: "transient",
    shouldRetry: true,
    backoffMs: 5000,
    message: body || `Unknown status: ${status}`,
  };
}

/**
 * Classify a ClickHouse-specific error for consistent handling.
 * Wraps classifyError with ClassifiedError return type.
 */
export function classifyClickHouseError(error: unknown): ClassifiedError {
  const severity = classifyError(error);
  const msg = String(error);

  const backoffMap: Record<ErrorType, number | undefined> = {
    transient: 5000,
    rate_limit: 30000,
    client_error: undefined,
    permanent: undefined,
  };

  return {
    severity,
    shouldRetry: severity !== "client_error" && severity !== "permanent",
    backoffMs: backoffMap[severity],
    message: msg,
  };
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================

type CircuitState = "closed" | "open" | "half_open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailure = 0;
  private successes = 0;

  constructor(
    private threshold = 5,
    private resetMs = 60000,
    private halfOpenSuccesses = 2
  ) {}

  canExecute(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (Date.now() - this.lastFailure >= this.resetMs) {
        this.state = "half_open";
        this.successes = 0;
        return true;
      }
      return false;
    }

    return true; // half_open
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.successes++;
      if (this.successes >= this.halfOpenSuccesses) {
        this.state = "closed";
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === "half_open" || this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState { return this.state; }
}

// Global circuit breaker instance (shared across all consumers in a worker)
const circuitBreaker = new CircuitBreaker();

// ============================================================
// RELIABLE INSERT
// ============================================================

export interface InsertResult {
  success: boolean;
  shouldRetry: boolean;
  error?: string;
}

/**
 * Execute a ClickHouse insert with circuit breaker and error classification.
 * Returns whether messages should be retried or sent to DLQ.
 */
export async function executeInsert(
  url: string,
  headers: HeadersInit,
  body: string
): Promise<InsertResult> {
  // Check circuit breaker
  if (!circuitBreaker.canExecute()) {
    return { success: false, shouldRetry: true, error: "Circuit breaker open" };
  }

  try {
    const response = await fetch(url, { method: "POST", headers, body });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }

    circuitBreaker.recordSuccess();
    return { success: true, shouldRetry: false };
  } catch (err) {
    circuitBreaker.recordFailure();
    const errorType = classifyError(err);

    return {
      success: false,
      shouldRetry: errorType !== "client_error",
      error: String(err),
    };
  }
}

/**
 * Simplified insert helper that handles the common pattern.
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
 * Process a message batch with standard ack/retry logic.
 */
export function handleBatchResult<T>(
  messages: readonly Message<T>[],
  result: InsertResult,
  logPrefix: string
): void {
  if (result.success) {
    for (const msg of messages) msg.ack();
  } else if (result.shouldRetry) {
    console.error(`[${logPrefix}] Insert failed (will retry):`, result.error);
    for (const msg of messages) msg.retry();
  } else {
    // Client error - ack to prevent infinite loop, log for investigation
    console.error(`[${logPrefix}] Insert failed (non-retryable):`, result.error);
    for (const msg of messages) msg.ack();
  }
}
