// src/schemas/common.ts
// Shared Zod schemas for API request/response validation

import { z } from "zod";
import type { ErrorCode } from "../errors";

// ============================================================
// Branded Types (Re-exported from core for schema use)
// ============================================================

/**
 * Asset ID - unique identifier for a tradeable instrument
 */
export const AssetIdSchema = z.string();

/**
 * Condition ID - market grouping identifier (links YES/NO tokens)
 */
export const ConditionIdSchema = z.string();

/**
 * Trigger ID - unique identifier for a registered trigger
 */
export const TriggerIdSchema = z.string();

// ============================================================
// Pagination Schemas
// ============================================================

export const PaginationQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .default("100")
    .transform((v) => Math.min(parseInt(v, 10) || 100, 1000)),
  offset: z
    .string()
    .optional()
    .default("0")
    .transform((v) => parseInt(v, 10) || 0),
});

export const PaginationResponseSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
  has_more: z.boolean(),
});

// ============================================================
// Error Response Schema
// ============================================================

export const ErrorCodeSchema = z.enum([
  "MISSING_FIELD",
  "INVALID_FIELD",
  "INVALID_TRIGGER_TYPE",
  "INVALID_THRESHOLD",
  "INVALID_ASSET_ID",
  "INVALID_COOLDOWN",
  "MARKET_NOT_FOUND",
  "TRIGGER_NOT_FOUND",
  "ASSET_NOT_SUBSCRIBED",
  "RATE_LIMITED",
  "COOLDOWN_ACTIVE",
  "AUTHENTICATION_REQUIRED",
  "INVALID_API_KEY",
  "INVALID_SIGNATURE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "CLICKHOUSE_ERROR",
  "WEBSOCKET_ERROR",
  "INTERNAL_ERROR",
  "PARSE_ERROR",
]) satisfies z.ZodType<ErrorCode>;

export const ErrorDetailSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================
// Response Meta Schema
// ============================================================

export const ResponseMetaSchema = z.object({
  timestamp: z.string(),
  request_id: z.string(),
  latency_ms: z.number(),
});

// ============================================================
// Standard API Response Envelope
// ============================================================

/**
 * Creates a typed API response schema with standardized envelope
 */
export function createResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: ResponseMetaSchema,
  });
}

/**
 * Error response schema (when success = false)
 */
export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: ErrorDetailSchema,
  meta: ResponseMetaSchema,
});

// ============================================================
// Market Source & Type Enums
// ============================================================

/**
 * Supported market sources. Currently only Polymarket is active.
 * To add new markets, extend this schema and implement the adapter.
 */
export const MarketSourceSchema = z.enum(["polymarket"]);

/**
 * Market type categories. Currently only prediction markets are supported.
 */
export const MarketTypeSchema = z.enum(["prediction"]);

// ============================================================
// Price & Orderbook Schemas
// ============================================================

export const PriceLevelSchema = z.object({
  price: z.number(),
  size: z.number(),
});

export const CurrentPriceSchema = z.object({
  bid: z.number(),
  ask: z.number(),
  mid: z.number(),
  spread_bps: z.number(),
});

export const Stats24hSchema = z.object({
  tick_count: z.number(),
  volume_usd: z.number().optional(),
  high: z.number(),
  low: z.number(),
});

// ============================================================
// User Tier (for rate limiting)
// ============================================================

export const UserTierSchema = z.enum(["free", "pro", "enterprise"]);

export type UserTier = z.infer<typeof UserTierSchema>;
