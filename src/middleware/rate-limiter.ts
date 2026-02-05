// src/middleware/rate-limiter.ts
// Tiered rate limiting middleware using KV storage

import type { Context, Next } from "hono";
import type { Env } from "../types";
import type { UserTier, DataTier } from "../schemas/common";
import { TIER_LIMITS } from "../schemas/common";
import { RateLimitError } from "../errors";

// ============================================================
// Rate Limit Configuration
// ============================================================

/**
 * Rate limits per tier (requests per minute)
 * - data: Read-only data endpoints (markets, ohlc, orderbook)
 * - admin: Write operations (triggers, webhooks)
 */
export const RATE_LIMITS: Record<UserTier, { data: number; admin: number }> = {
  free: { data: 60, admin: 15 },       // 60 req/min data, 15 req/min admin
  pro: { data: 120, admin: 30 },       // Default tier
  enterprise: { data: 600, admin: 120 }, // 10x free tier
};

/**
 * Endpoint classification for rate limiting
 */
export type EndpointType = "data" | "admin";

/**
 * Classify an endpoint for rate limiting
 */
export function classifyEndpoint(method: string, path: string): EndpointType {
  // Admin endpoints (write operations)
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    return "admin";
  }

  // Admin paths even for GET
  if (path.includes("/triggers") && !path.includes("/events")) {
    return "admin";
  }
  if (path.includes("/lifecycle") || path.includes("/admin")) {
    return "admin";
  }

  // Everything else is data
  return "data";
}

// ============================================================
// Rate Limit Key Generation
// ============================================================

/**
 * Generate rate limit key for KV storage
 * Format: ratelimit:{api_key_hash}:{endpoint_type}:{minute}
 */
function getRateLimitKey(apiKeyHash: string, endpointType: EndpointType): string {
  const minute = Math.floor(Date.now() / 60000);
  return `ratelimit:${apiKeyHash}:${endpointType}:${minute}`;
}

/**
 * Hash API key for privacy (don't store raw keys in KV)
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// Tier Resolution
// ============================================================

/**
 * Get user tier from API key metadata
 * Returns "pro" as default if no tier is set
 */
async function getUserTier(kv: KVNamespace, apiKeyHash: string): Promise<UserTier> {
  try {
    const tierData = await kv.get(`tier:${apiKeyHash}`);
    if (tierData && ["free", "pro", "enterprise"].includes(tierData)) {
      return tierData as UserTier;
    }
  } catch {
    // Fall through to default
  }
  return "pro"; // Default tier
}

// ============================================================
// Rate Limit Middleware
// ============================================================

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  tier: UserTier;
}

/**
 * Rate limit middleware factory
 *
 * @param options Configuration options
 * @returns Hono middleware
 */
export function rateLimiter(options?: {
  /** Skip rate limiting for these paths */
  skipPaths?: string[];
  /** Custom tier resolver */
  tierResolver?: (c: Context<{ Bindings: Env }>) => Promise<UserTier>;
}) {
  const skipPaths = options?.skipPaths ?? ["/health", "/api/v1/openapi.json", "/api/v1/docs"];

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = new URL(c.req.url).pathname;

    // Skip rate limiting for certain paths
    if (skipPaths.some((skip) => path.startsWith(skip))) {
      return next();
    }

    // Get API key from header
    const apiKey = c.req.header("X-API-Key");
    if (!apiKey) {
      // No API key = use IP-based limiting with free tier
      // For now, just proceed without rate limiting for unauthenticated requests
      // (they'll be blocked by auth middleware anyway)
      return next();
    }

    const kv = c.env.MARKET_CACHE;
    const apiKeyHash = await hashApiKey(apiKey);
    const endpointType = classifyEndpoint(c.req.method, path);
    const key = getRateLimitKey(apiKeyHash, endpointType);

    // Get user tier
    const tier = options?.tierResolver
      ? await options.tierResolver(c)
      : await getUserTier(kv, apiKeyHash);

    const limit = RATE_LIMITS[tier][endpointType];
    const minuteStart = Math.floor(Date.now() / 60000) * 60000;
    const reset = minuteStart + 60000;

    // Get current count
    let current = 0;
    try {
      const countStr = await kv.get(key);
      current = countStr ? parseInt(countStr, 10) : 0;
    } catch {
      // KV read failed, allow the request
      current = 0;
    }

    // Check if over limit
    if (current >= limit) {
      const retryAfterMs = reset - Date.now();
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      // Set rate limit headers even on rejection
      c.header("X-RateLimit-Limit", String(limit));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.floor(reset / 1000)));
      c.header("X-RateLimit-Tier", tier);
      c.header("Retry-After", String(retryAfterSec));

      const error = new RateLimitError(retryAfterMs, {
        limit,
        remaining: 0,
        reset,
        tier,
        endpoint_type: endpointType,
      });

      return c.json(error.toJSON(), 429);
    }

    // Increment counter
    try {
      const ttl = 120; // 2 minutes TTL (covers current + next minute)
      await kv.put(key, String(current + 1), { expirationTtl: ttl });
    } catch {
      // KV write failed, allow the request anyway
    }

    // Set rate limit headers
    const remaining = Math.max(0, limit - current - 1);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.floor(reset / 1000)));
    c.header("X-RateLimit-Tier", tier);

    return next();
  };
}

// ============================================================
// Admin Functions
// ============================================================

/**
 * Set user tier (admin operation)
 */
export async function setUserTier(
  kv: KVNamespace,
  apiKey: string,
  tier: UserTier
): Promise<void> {
  const apiKeyHash = await hashApiKey(apiKey);
  await kv.put(`tier:${apiKeyHash}`, tier, { expirationTtl: 86400 * 365 }); // 1 year
}

/**
 * Get current rate limit status for a user
 */
export async function getRateLimitStatus(
  kv: KVNamespace,
  apiKey: string
): Promise<{
  tier: UserTier;
  data: { current: number; limit: number };
  admin: { current: number; limit: number };
}> {
  const apiKeyHash = await hashApiKey(apiKey);
  const tier = await getUserTier(kv, apiKeyHash);
  const limits = RATE_LIMITS[tier];

  const dataKey = getRateLimitKey(apiKeyHash, "data");
  const adminKey = getRateLimitKey(apiKeyHash, "admin");

  const [dataCount, adminCount] = await Promise.all([
    kv.get(dataKey).then((v) => (v ? parseInt(v, 10) : 0)),
    kv.get(adminKey).then((v) => (v ? parseInt(v, 10) : 0)),
  ]);

  return {
    tier,
    data: { current: dataCount, limit: limits.data },
    admin: { current: adminCount, limit: limits.admin },
  };
}

// ============================================================
// Data Tier Functions (Historical Data Access)
// ============================================================

/**
 * Get data tier from API key metadata
 * Returns "starter" as default if no tier is set
 */
export async function getDataTier(kv: KVNamespace, apiKeyHash: string): Promise<DataTier> {
  try {
    const tierData = await kv.get(`data_tier:${apiKeyHash}`);
    if (tierData && ["starter", "pro", "team", "business"].includes(tierData)) {
      return tierData as DataTier;
    }
  } catch {
    // Fall through to default
  }
  return "starter"; // Default tier
}

/**
 * Set data tier for a user (admin operation)
 */
export async function setDataTier(
  kv: KVNamespace,
  apiKey: string,
  tier: DataTier
): Promise<void> {
  const apiKeyHash = await hashApiKey(apiKey);
  await kv.put(`data_tier:${apiKeyHash}`, tier, { expirationTtl: 86400 * 365 }); // 1 year
}

// ============================================================
// Date Range Validation Middleware
// ============================================================

export interface DateRangeValidationResult {
  valid: boolean;
  tier: DataTier;
  requestedDays: number;
  allowedDays: number;
  startDate: Date;
  endDate: Date;
  error?: string;
}

/**
 * Validate date range against tier limits
 */
export function validateDateRangeForTier(
  startDate: Date,
  endDate: Date,
  tier: DataTier
): DateRangeValidationResult {
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const requestedDays = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay);
  const allowedDays = TIER_LIMITS[tier].historicalDays;

  if (startDate > endDate) {
    return {
      valid: false,
      tier,
      requestedDays,
      allowedDays,
      startDate,
      endDate,
      error: "Start date must be before end date",
    };
  }

  if (allowedDays !== Infinity && requestedDays > allowedDays) {
    const oldestAllowed = new Date(now.getTime() - allowedDays * msPerDay);
    return {
      valid: false,
      tier,
      requestedDays,
      allowedDays,
      startDate,
      endDate,
      error: `Your ${tier} tier allows ${allowedDays} days of historical data. Requested: ${requestedDays} days. Oldest allowed: ${oldestAllowed.toISOString().split("T")[0]}`,
    };
  }

  return {
    valid: true,
    tier,
    requestedDays,
    allowedDays,
    startDate,
    endDate,
  };
}

/**
 * Date range validation middleware factory
 * Enforces tier-based historical data limits
 */
export function validateDateRange(options?: {
  /** Query parameter name for start date */
  startParam?: string;
  /** Query parameter name for end date */
  endParam?: string;
  /** Custom tier resolver */
  tierResolver?: (c: Context<{ Bindings: Env }>) => Promise<DataTier>;
}) {
  const startParam = options?.startParam ?? "start";
  const endParam = options?.endParam ?? "end";

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const startStr = c.req.query(startParam);
    const endStr = c.req.query(endParam);

    // If no date params, skip validation (endpoint may have defaults)
    if (!startStr || !endStr) {
      return next();
    }

    const startDate = new Date(startStr);
    const endDate = new Date(endStr);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return c.json({
        success: false,
        error: {
          code: "INVALID_FIELD",
          message: "Invalid date format",
          details: {
            [startParam]: startStr,
            [endParam]: endStr,
          },
        },
      }, 400);
    }

    // Get API key and data tier
    const apiKey = c.req.header("X-API-Key");
    let tier: DataTier = "starter";

    if (apiKey) {
      const apiKeyHash = await hashApiKey(apiKey);
      tier = options?.tierResolver
        ? await options.tierResolver(c)
        : await getDataTier(c.env.MARKET_CACHE, apiKeyHash);
    }

    const validation = validateDateRangeForTier(startDate, endDate, tier);

    if (!validation.valid) {
      return c.json({
        success: false,
        error: {
          code: "DATE_RANGE_EXCEEDED",
          message: validation.error,
          details: {
            tier,
            requested_days: validation.requestedDays,
            allowed_days: validation.allowedDays,
            upgrade_url: "https://docs.example.com/pricing",
          },
        },
      }, 403);
    }

    // Note: Tier info should be retrieved in handlers via getDataTier()
    // since Hono context typing doesn't support dynamic variables without app-level typing
    return next();
  };
}

// ============================================================
// Usage Tracking
// ============================================================

/**
 * Get current billing cycle in YYYY-MM format
 */
function getCurrentBillingCycle(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Track usage for billing purposes
 * Fire-and-forget - doesn't block response
 */
export async function trackUsage(
  env: Env,
  apiKeyHash: string,
  tier: DataTier,
  endpoint: string,
  rowsReturned: number
): Promise<void> {
  const billingCycle = getCurrentBillingCycle();
  const timestamp = new Date().toISOString();

  // Insert into ClickHouse usage_events table
  const row = {
    api_key_hash: apiKeyHash,
    tier,
    endpoint,
    rows_returned: rowsReturned,
    timestamp,
    billing_cycle: billingCycle,
  };

  const body = JSON.stringify(row);
  const url = new URL(env.CLICKHOUSE_URL);
  url.searchParams.set("query", "INSERT INTO trading_data.usage_events FORMAT JSONEachRow");
  url.searchParams.set("async_insert", "1");
  url.searchParams.set("wait_for_async_insert", "0");

  try {
    await fetch(url.toString(), {
      method: "POST",
      headers: {
        "X-ClickHouse-User": env.CLICKHOUSE_USER,
        "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
        "Content-Type": "application/x-ndjson",
      },
      body,
    });
  } catch (error) {
    // Fire-and-forget - log but don't throw
    console.error("[UsageTracker] Failed to track usage:", error);
  }
}

/**
 * Get usage summary for an API key
 */
export async function getUsageSummary(
  env: Env,
  apiKey: string
): Promise<{
  tier: DataTier;
  billingCycle: string;
  totalRows: number;
  estimatedCost: number;
  byEndpoint: Array<{ endpoint: string; rows: number }>;
}> {
  const apiKeyHash = await hashApiKey(apiKey);
  const tier = await getDataTier(env.MARKET_CACHE, apiKeyHash);
  const billingCycle = getCurrentBillingCycle();

  const query = `
    SELECT
      endpoint,
      sum(rows_returned) AS total_rows
    FROM trading_data.usage_events
    WHERE api_key_hash = {hash:String}
      AND billing_cycle = {cycle:String}
    GROUP BY endpoint
    ORDER BY total_rows DESC
    FORMAT JSON
  `;

  const url = new URL(env.CLICKHOUSE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("param_hash", apiKeyHash);
  url.searchParams.set("param_cycle", billingCycle);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-ClickHouse-User": env.CLICKHOUSE_USER,
        "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
      },
    });

    if (!response.ok) {
      throw new Error(`ClickHouse query failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      data: Array<{ endpoint: string; total_rows: string }>;
    };

    const byEndpoint = result.data.map((r) => ({
      endpoint: r.endpoint,
      rows: parseInt(r.total_rows, 10),
    }));

    const totalRows = byEndpoint.reduce((sum, r) => sum + r.rows, 0);
    const overageRate = TIER_LIMITS[tier].overageRate;
    const estimatedCost = overageRate ? (totalRows / 1000) * overageRate : 0;

    return {
      tier,
      billingCycle,
      totalRows,
      estimatedCost,
      byEndpoint,
    };
  } catch (error) {
    console.error("[UsageTracker] Failed to get usage summary:", error);
    return {
      tier,
      billingCycle,
      totalRows: 0,
      estimatedCost: 0,
      byEndpoint: [],
    };
  }
}
