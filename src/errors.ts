// src/errors.ts
// Typed error hierarchy for consistent API error handling

/**
 * Error codes for programmatic error handling
 */
export type ErrorCode =
  // Validation errors
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "INVALID_TRIGGER_TYPE"
  | "INVALID_THRESHOLD"
  | "INVALID_ASSET_ID"
  | "INVALID_COOLDOWN"
  // Resource errors
  | "MARKET_NOT_FOUND"
  | "TRIGGER_NOT_FOUND"
  | "ASSET_NOT_SUBSCRIBED"
  // Rate limiting
  | "RATE_LIMITED"
  | "COOLDOWN_ACTIVE"
  // Authentication
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_API_KEY"
  | "INVALID_SIGNATURE"
  // Network/External
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CLICKHOUSE_ERROR"
  | "WEBSOCKET_ERROR"
  // Internal
  | "INTERNAL_ERROR"
  | "PARSE_ERROR";

/**
 * Base API error class with error codes
 */
export class APIError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryable: boolean = false,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "APIError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, APIError);
    }
  }

  toJSON(): {
    error: string;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
    retryAfter?: number;
  } {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
    };
  }
}

/**
 * Validation errors - malformed request data
 */
export class ValidationError extends APIError {
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(code, message, details, false);
    this.name = "ValidationError";
  }
}

/**
 * Invalid field value
 */
export class InvalidFieldError extends ValidationError {
  constructor(
    field: string,
    value: unknown,
    expected?: string,
    context?: string
  ) {
    const msg = expected
      ? `Invalid value for '${field}': expected ${expected}, got ${typeof value}`
      : `Invalid value for field '${field}'`;
    super("INVALID_FIELD", msg, { field, value, expected, context });
    this.name = "InvalidFieldError";
  }
}

/**
 * Resource not found errors
 */
export class NotFoundError extends APIError {
  constructor(resource: string, identifier: string) {
    super("MARKET_NOT_FOUND", `${resource} not found: ${identifier}`, {
      resource,
      identifier,
    });
    this.name = "NotFoundError";
  }
}

/**
 * Market/Asset not found error
 */
export class MarketNotFoundError extends NotFoundError {
  constructor(assetId: string) {
    super("Market", assetId);
    this.name = "MarketNotFoundError";
  }
}

/**
 * Rate limiting error with retry guidance
 */
export class RateLimitError extends APIError {
  constructor(retryAfterMs: number, details?: Record<string, unknown>) {
    super(
      "RATE_LIMITED",
      `Rate limit exceeded. Retry after ${retryAfterMs}ms`,
      details,
      true,
      retryAfterMs
    );
    this.name = "RateLimitError";
  }
}

/**
 * ClickHouse database error
 */
export class ClickHouseError extends APIError {
  constructor(
    message: string,
    query?: string,
    originalError?: unknown
  ) {
    super(
      "CLICKHOUSE_ERROR",
      message,
      {
        query: query?.slice(0, 500),
        originalError: originalError instanceof Error ? originalError.message : originalError,
      },
      true
    );
    this.name = "ClickHouseError";
  }
}

/**
 * Asset not subscribed error
 */
export class AssetNotSubscribedError extends APIError {
  constructor(assetId: string, hint?: string) {
    super(
      "ASSET_NOT_SUBSCRIBED",
      `Asset not subscribed: ${assetId}`,
      { assetId, hint },
      false
    );
    this.name = "AssetNotSubscribedError";
  }
}

/**
 * Configuration error - missing required environment variables
 */
export class ConfigurationError extends APIError {
  constructor(missingConfig: string) {
    super(
      "INTERNAL_ERROR",
      `Missing required configuration: ${missingConfig}`,
      { missingConfig },
      false
    );
    this.name = "ConfigurationError";
  }
}

/**
 * Check if an error is an APIError
 */
export function isAPIError(error: unknown): error is APIError {
  return error instanceof APIError;
}

/**
 * Convert any error to an APIError
 */
export function toAPIError(error: unknown): APIError {
  if (isAPIError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new APIError("INTERNAL_ERROR", error.message, {
      stack: error.stack,
    });
  }
  return new APIError("INTERNAL_ERROR", String(error));
}

/**
 * Create a JSON response from an error
 */
export function errorResponse(error: unknown): {
  body: ReturnType<APIError["toJSON"]>;
  status: number;
} {
  const apiError = toAPIError(error);

  const statusMap: Partial<Record<ErrorCode, number>> = {
    MISSING_FIELD: 400,
    INVALID_FIELD: 400,
    INVALID_TRIGGER_TYPE: 400,
    INVALID_THRESHOLD: 400,
    INVALID_ASSET_ID: 400,
    INVALID_COOLDOWN: 400,
    AUTHENTICATION_REQUIRED: 401,
    INVALID_API_KEY: 401,
    INVALID_SIGNATURE: 401,
    MARKET_NOT_FOUND: 404,
    TRIGGER_NOT_FOUND: 404,
    ASSET_NOT_SUBSCRIBED: 404,
    RATE_LIMITED: 429,
    COOLDOWN_ACTIVE: 429,
    NETWORK_ERROR: 502,
    TIMEOUT: 504,
    WEBSOCKET_ERROR: 502,
    CLICKHOUSE_ERROR: 503,
    INTERNAL_ERROR: 500,
    PARSE_ERROR: 500,
  };

  return {
    body: apiError.toJSON(),
    status: statusMap[apiError.code] || 500,
  };
}
