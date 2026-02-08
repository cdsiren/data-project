// src/middleware/rate-limiter.ts
// Tiered rate limiting middleware using KV storage

import type { Context, Next } from "hono";
import type { Env } from "../types";
import type { UserTier } from "../schemas/common";
import { RateLimitError } from "../errors";
import { getFullTableName } from "../config/database";
import { toClickHouseDateTime64 } from "../utils/datetime";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "../services/clickhouse-client";

// ============================================================
// Usage Event Logging
// ============================================================

/** Usage event row for ClickHouse */
interface UsageEventRow {
  api_key_hash: string;
  tier: string;
  endpoint: string;
  rows_returned: number;
  timestamp: string;
  billing_cycle: string;
}

/** Buffer for batched usage event inserts */
let usageEventBuffer: UsageEventRow[] = [];
let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Get current billing cycle (YYYY-MM format)
 */
function getBillingCycle(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Log a usage event to the buffer (will be flushed to ClickHouse)
 */
export function logUsageEvent(
  apiKeyHash: string,
  tier: UserTier,
  endpoint: string,
  rowsReturned: number = 0
): void {
  usageEventBuffer.push({
    api_key_hash: apiKeyHash,
    tier,
    endpoint,
    rows_returned: rowsReturned,
    timestamp: toClickHouseDateTime64(Date.now()),
    billing_cycle: getBillingCycle(),
  });

  // Schedule flush if not already set (flush every 5 seconds)
  if (!usageFlushTimer) {
    usageFlushTimer = setTimeout(() => {
      flushUsageEvents();
    }, 5000);
  }

  // Flush immediately if buffer is large
  if (usageEventBuffer.length >= 100) {
    flushUsageEvents();
  }
}

/**
 * Flush usage events to ClickHouse
 */
async function flushUsageEvents(env?: Env): Promise<void> {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }

  const buffer = usageEventBuffer;
  if (buffer.length === 0) return;
  usageEventBuffer = [];

  // Need env to flush - store it from middleware context
  if (!cachedEnv) return;

  try {
    const body = buffer.map((r) => JSON.stringify(r)).join("\n");
    const url = buildAsyncInsertUrl(cachedEnv.CLICKHOUSE_URL, getFullTableName("USAGE_EVENTS"));
    const headers = buildClickHouseHeaders(cachedEnv.CLICKHOUSE_USER, cachedEnv.CLICKHOUSE_TOKEN);

    await fetch(url, { method: "POST", headers, body });
  } catch (e) {
    console.error("[UsageEvents] Flush failed:", e);
  }
}

/** Cached env for async flushes */
let cachedEnv: Env | null = null;

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
async function hashApiKey(apiKey: string): Promise<string> {
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

    // Cache env for async usage event flushes
    cachedEnv = c.env;

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

    // Execute the request handler
    await next();

    // Log usage event after request completes (fire-and-forget)
    // Note: rows_returned is 0 here; can be enhanced by response handlers
    logUsageEvent(apiKeyHash, tier, path, 0);
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
