// src/middleware/response-wrapper.ts
// Response standardization middleware

import type { Context, Next } from "hono";
import type { Env } from "../types";
import { isAPIError, toAPIError, type ErrorCode } from "../errors";

// ============================================================
// Response Envelope Types
// ============================================================

export interface APIResponseMeta {
  timestamp: string;
  request_id: string;
  latency_ms: number;
}

export interface APISuccessResponse<T> {
  success: true;
  data: T;
  meta: APIResponseMeta;
}

export interface APIErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: APIResponseMeta;
}

export type APIResponse<T> = APISuccessResponse<T> | APIErrorResponse;

// ============================================================
// Request ID Generation
// ============================================================

/**
 * Generate a UUID v4 request ID
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

// ============================================================
// Response Wrapper Middleware
// ============================================================

/**
 * Middleware that wraps all JSON responses in a standard envelope
 * and adds timing/tracing headers.
 *
 * Envelope format:
 * {
 *   success: boolean,
 *   data: T (on success) | undefined,
 *   error: { code, message, details } (on error),
 *   meta: { timestamp, request_id, latency_ms }
 * }
 */
export function responseWrapper(options?: {
  /** Paths to skip wrapping (e.g., SSE endpoints) */
  skipPaths?: string[];
  /** Custom request ID header name */
  requestIdHeader?: string;
}) {
  const skipPaths = options?.skipPaths ?? [
    "/api/v1/triggers/events/sse",
    "/api/v1/openapi.json",
    "/api/v1/docs",
    "/health",
  ];
  const requestIdHeader = options?.requestIdHeader ?? "X-Request-Id";

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = new URL(c.req.url).pathname;

    // Skip wrapping for certain paths
    if (skipPaths.some((skip) => path.startsWith(skip))) {
      return next();
    }

    // Generate request ID and start timer
    const requestId = c.req.header(requestIdHeader) || generateRequestId();
    const startTime = Date.now();

    // Set request ID header early (for error responses too)
    c.header(requestIdHeader, requestId);

    try {
      await next();

      // Calculate latency
      const latencyMs = Date.now() - startTime;
      c.header("X-Response-Time", `${latencyMs}ms`);

      // If response is already sent (streaming, etc.), don't modify
      if (c.res.bodyUsed) {
        return;
      }

      // Only wrap JSON responses
      const contentType = c.res.headers.get("Content-Type") || "";
      if (!contentType.includes("application/json")) {
        return;
      }

      // Clone the response to read the body
      const originalResponse = c.res.clone();
      let body: unknown;

      try {
        body = await originalResponse.json();
      } catch {
        // Not valid JSON, skip wrapping
        return;
      }

      // Check if already wrapped (has success field)
      if (typeof body === "object" && body !== null && "success" in body) {
        // Already wrapped, just update meta
        const wrapped = body as APIResponse<unknown>;
        wrapped.meta = {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          latency_ms: latencyMs,
        };
        c.res = new Response(JSON.stringify(wrapped), {
          status: c.res.status,
          headers: c.res.headers,
        });
        return;
      }

      // Determine if this is an error response based on status code
      const status = c.res.status;
      const isError = status >= 400;

      // Build wrapped response
      const meta: APIResponseMeta = {
        timestamp: new Date().toISOString(),
        request_id: requestId,
        latency_ms: latencyMs,
      };

      let wrappedBody: APIResponse<unknown>;

      if (isError) {
        // Error response - extract error info from body
        const errorBody = body as Record<string, unknown>;
        wrappedBody = {
          success: false,
          error: {
            code: (errorBody.code as ErrorCode) || "INTERNAL_ERROR",
            message: (errorBody.message as string) || (errorBody.error as string) || "An error occurred",
            details: errorBody.details as Record<string, unknown> | undefined,
          },
          meta,
        };
      } else {
        // Success response - wrap data
        wrappedBody = {
          success: true,
          data: body,
          meta,
        };
      }

      c.res = new Response(JSON.stringify(wrappedBody), {
        status,
        headers: c.res.headers,
      });
    } catch (error) {
      // Handle thrown errors
      const latencyMs = Date.now() - startTime;
      c.header("X-Response-Time", `${latencyMs}ms`);

      const apiError = toAPIError(error);
      const meta: APIResponseMeta = {
        timestamp: new Date().toISOString(),
        request_id: requestId,
        latency_ms: latencyMs,
      };

      const errorResponse: APIErrorResponse = {
        success: false,
        error: {
          code: apiError.code,
          message: apiError.message,
          details: apiError.details,
        },
        meta,
      };

      // Map error code to HTTP status
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

      const status = statusMap[apiError.code] || 500;

      // Add Retry-After header for rate limit errors
      if (apiError.retryAfter) {
        c.header("Retry-After", String(Math.ceil(apiError.retryAfter / 1000)));
      }

      return c.json(errorResponse, status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504);
    }
  };
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Create a success response with proper envelope
 */
export function successResponse<T>(
  c: Context,
  data: T,
  status: number = 200
): Response {
  const requestId = c.get("requestId") || crypto.randomUUID();
  const startTime = c.get("startTime") || Date.now();
  const latencyMs = Date.now() - (startTime as number);

  const response: APISuccessResponse<T> = {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      request_id: requestId as string,
      latency_ms: latencyMs,
    },
  };

  return c.json(response, status as 200);
}

/**
 * Create an error response with proper envelope
 */
export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  status: number = 500,
  details?: Record<string, unknown>
): Response {
  const requestId = c.get("requestId") || crypto.randomUUID();
  const startTime = c.get("startTime") || Date.now();
  const latencyMs = Date.now() - (startTime as number);

  const response: APIErrorResponse = {
    success: false,
    error: {
      code,
      message,
      details,
    },
    meta: {
      timestamp: new Date().toISOString(),
      request_id: requestId as string,
      latency_ms: latencyMs,
    },
  };

  return c.json(response, status as 400 | 401 | 403 | 404 | 429 | 500);
}
