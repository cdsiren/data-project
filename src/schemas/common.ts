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

// ============================================================
// Data Tier (for historical data access)
// Independent from rate limit tiers - controls backtest access
// ============================================================

/**
 * Data access tiers determine historical data access limits.
 * - starter: 7 days, no backtest access
 * - pro: 90 days, read-only backtest (JSON only)
 * - team: 365 days, full backtest + export (CSV/Parquet)
 * - business: unlimited, full access + bulk API
 */
export const DataTierSchema = z.enum(["starter", "pro", "team", "business"]);

export type DataTier = z.infer<typeof DataTierSchema>;

/**
 * Tier limits for historical data access and backtest features.
 * These are independent from rate limiting tiers.
 */
export const TIER_LIMITS = {
  starter: {
    historicalDays: 7,
    backtestAccess: "none" as const,
    exportFormats: [] as const,
    overageRate: null, // No overage allowed
  },
  pro: {
    historicalDays: 90,
    backtestAccess: "read" as const,
    exportFormats: ["json"] as const,
    overageRate: 0.005, // $0.005 per 1000 rows
  },
  team: {
    historicalDays: 365,
    backtestAccess: "full" as const,
    exportFormats: ["json", "csv", "parquet"] as const,
    overageRate: 0.003, // $0.003 per 1000 rows
  },
  business: {
    historicalDays: Infinity,
    backtestAccess: "full" as const,
    exportFormats: ["json", "csv", "parquet"] as const,
    overageRate: 0.001, // $0.001 per 1000 rows
  },
} as const;

export type TierLimits = typeof TIER_LIMITS;
export type BacktestAccess = "none" | "read" | "full";
export type ExportFormat = "json" | "csv" | "parquet";

// ============================================================
// Archive Schemas
// ============================================================

/**
 * Archive job types
 */
export const ArchiveTypeSchema = z.enum(["resolved", "aged"]);
export type ArchiveType = z.infer<typeof ArchiveTypeSchema>;

/**
 * Archive job message for queue processing
 */
export const ArchiveJobSchema = z.object({
  type: ArchiveTypeSchema,
  conditionId: z.string().optional(), // For resolved market archives
  database: z.string().optional(),    // For aged data archives
  table: z.string().optional(),       // For aged data archives
  cutoffDate: z.string().optional(),  // ISO date string for aged cutoff
  month: z.string().optional(),       // YYYY-MM for partitioning
});

export type ArchiveJob = z.infer<typeof ArchiveJobSchema>;

/**
 * Date range query parameters for backtest endpoints
 */
export const DateRangeQuerySchema = z.object({
  start: z.string(),
  end: z.string(),
  asset_id: z.string().optional(),
  condition_id: z.string().optional(),
});

export type DateRangeQuery = z.infer<typeof DateRangeQuerySchema>;
