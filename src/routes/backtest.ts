// src/routes/backtest.ts
// Backtest data export endpoints for historical data queries
// Implements tier-based access control and usage tracking

import { Hono, Context, Next } from "hono";
import type { Env } from "../types";
import { DB_CONFIG } from "../config/database";
import {
  TIER_LIMITS,
  type DataTier,
  type ExportFormat
} from "../schemas/common";
import {
  getDataTier,
  trackUsage,
  getUsageSummary,
  hashApiKey,
} from "../middleware/rate-limiter";
import {
  ArchiveQueryService,
  getRequiredTier,
} from "../services/archive-query";
import { runArchiveBackfill } from "../consumers/archive-consumer";

const backtest = new Hono<{ Bindings: Env }>();

// ============================================================
// Auth Middleware
// ============================================================

/**
 * Auth middleware for backtest API
 * Returns both authentication status and data tier
 */
const authMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.VITE_DASHBOARD_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

// ============================================================
// Admin Endpoints (separate auth - defined before main middleware)
// ============================================================

/**
 * Trigger archive backfill for all resolved markets and aged data.
 * This endpoint queues archival jobs but does NOT delete any data.
 *
 * POST /admin/backfill
 * Header: X-Admin-Key (required)
 *
 * Safety: Data remains in ClickHouse until manual deletion.
 */
backtest.post("/admin/backfill", async (c) => {
  const adminKey = c.req.header("X-Admin-Key");
  if (!adminKey || adminKey !== c.env.ADMIN_API_KEY) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  try {
    const result = await runArchiveBackfill(c.env);
    return c.json({
      success: true,
      marketsQueued: result.marketsQueued,
      agedTablesQueued: result.agedTablesQueued,
      message: "Archive jobs queued. Data will be copied to R2 without deletion.",
    });
  } catch (error) {
    console.error("[Backtest] Archive backfill failed:", error);
    return c.json({ error: "Backfill failed", details: String(error) }, 500);
  }
});

backtest.use("*", authMiddleware);

// ============================================================
// Tier Enforcement Middleware
// ============================================================

/**
 * Get tier info for current request
 */
async function getTierInfo(c: Context<{ Bindings: Env }>): Promise<{ tier: DataTier; apiKeyHash: string }> {
  const apiKey = c.req.header("X-API-Key") || "";
  const apiKeyHash = await hashApiKey(apiKey);
  const tier = await getDataTier(c.env.MARKET_CACHE, apiKeyHash);
  return { tier, apiKeyHash };
}

/**
 * Middleware to enforce tier-based access for backtest endpoints
 */
const tierEnforcement = (requiredAccess: "read" | "full") => {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const { tier } = await getTierInfo(c);
    const tierLimits = TIER_LIMITS[tier];

    // Check backtest access level
    if (tierLimits.backtestAccess === "none") {
      return c.json({
        error: "Backtest access not available",
        message: `Your ${tier} tier does not include backtest data access. Upgrade to Pro or higher.`,
        upgrade_url: "https://docs.example.com/pricing",
      }, 403);
    }

    if (requiredAccess === "full" && tierLimits.backtestAccess !== "full") {
      return c.json({
        error: "Full backtest access required",
        message: `This feature requires Team tier or higher. Your tier: ${tier}`,
        upgrade_url: "https://docs.example.com/pricing",
      }, 403);
    }

    await next();
  };
};

/**
 * Middleware to validate date range against tier limits
 */
const dateRangeEnforcement = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> => {
  const { tier } = await getTierInfo(c);
  const tierLimits = TIER_LIMITS[tier];

  const startStr = c.req.query("start");
  const endStr = c.req.query("end");

  if (!startStr || !endStr) {
    return next();
  }

  const startDate = new Date(startStr);
  const endDate = new Date(endStr);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return c.json({ error: "Invalid date format" }, 400);
  }

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const requestedDays = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay);

  if (tierLimits.historicalDays !== Infinity && requestedDays > tierLimits.historicalDays) {
    const oldestAllowed = new Date(now.getTime() - tierLimits.historicalDays * msPerDay);
    return c.json({
      error: "Date range exceeded",
      message: `Your ${tier} tier allows ${tierLimits.historicalDays} days of historical data.`,
      requested_days: requestedDays,
      allowed_days: tierLimits.historicalDays,
      oldest_allowed: oldestAllowed.toISOString().split("T")[0],
      required_tier: getRequiredTier(startDate),
      upgrade_url: "https://docs.example.com/pricing",
    }, 403);
  }

  await next();
};

// ============================================================
// Backtest Export Endpoints
// ============================================================

/**
 * Export historical data for backtesting.
 *
 * GET /export/backtest
 * Query params:
 *   - asset_id: Required. The asset/token ID to export.
 *   - start: Required. Start date (ISO 8601 or YYYY-MM-DD).
 *   - end: Required. End date (ISO 8601 or YYYY-MM-DD).
 *   - granularity: Optional. "tick" (default) or "ohlc".
 *   - limit: Optional. Max rows to return (default 100000, max 1000000).
 *
 * Tier restrictions:
 *   - Starter: No access (403)
 *   - Pro: Read access, JSON only, 90 days
 *   - Team: Full access, all formats, 1 year
 *   - Business: Full access, unlimited
 */
backtest.get(
  "/export/backtest",
  tierEnforcement("read"),
  dateRangeEnforcement,
  async (c) => {
    const { tier, apiKeyHash } = await getTierInfo(c);
    const tierLimits = TIER_LIMITS[tier];

    const assetId = c.req.query("asset_id");
    const start = c.req.query("start");
    const end = c.req.query("end");
    const granularity = c.req.query("granularity") || "tick";
    const limit = Math.min(
      parseInt(c.req.query("limit") || "100000", 10),
      1000000
    );

    // Validate required parameters
    if (!assetId) {
      return c.json({ error: "Missing required parameter: asset_id" }, 400);
    }
    if (!start || !end) {
      return c.json({ error: "Missing required parameters: start, end" }, 400);
    }

    // Validate granularity
    if (!["tick", "ohlc"].includes(granularity)) {
      return c.json({ error: "Invalid granularity. Use 'tick' or 'ohlc'" }, 400);
    }

    const headers = {
      "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
    };

    // Build query based on granularity
    const query = granularity === "ohlc"
      ? `
        SELECT
          toUnixTimestamp(minute) * 1000 AS time,
          toFloat64(argMinMerge(open_bid_state)) AS open_bid,
          toFloat64(argMaxMerge(close_bid_state)) AS close_bid,
          toFloat64(argMinMerge(open_ask_state)) AS open_ask,
          toFloat64(argMaxMerge(close_ask_state)) AS close_ask,
          toFloat64((argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2) AS open_mid,
          toFloat64((argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2) AS close_mid,
          toFloat64(avgMerge(avg_spread_bps_state)) AS avg_spread_bps,
          toUInt64(countMerge(tick_count_state)) AS tick_count,
          minMerge(sequence_start_state) AS sequence_start,
          maxMerge(sequence_end_state) AS sequence_end
        FROM ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m
        WHERE asset_id = {asset_id:String}
          AND minute BETWEEN parseDateTimeBestEffort({start:String}) AND parseDateTimeBestEffort({end:String})
        GROUP BY minute
        ORDER BY minute ASC
        LIMIT ${limit}
        FORMAT JSON
      `
      : `
        SELECT
          source_ts,
          toFloat64(best_bid) AS best_bid,
          toFloat64(best_ask) AS best_ask,
          bid_size,
          ask_size,
          toFloat64(mid_price) AS mid_price,
          spread_bps,
          book_hash,
          sequence_number
        FROM ${DB_CONFIG.DATABASE}.ob_bbo
        WHERE asset_id = {asset_id:String}
          AND source_ts BETWEEN parseDateTimeBestEffort({start:String}) AND parseDateTimeBestEffort({end:String})
        ORDER BY source_ts ASC, sequence_number ASC
        LIMIT ${limit}
        FORMAT JSON
      `;

    try {
      // Use parameterized query for safety
      const url = new URL(c.env.CLICKHOUSE_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("param_asset_id", assetId);
      url.searchParams.set("param_start", start);
      url.searchParams.set("param_end", end);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        const error = await response.text();
        return c.json({ error: "ClickHouse query failed", details: error }, 500);
      }

      const result = (await response.json()) as {
        data: Record<string, unknown>[];
        rows: number;
      };

      // Track usage for billing (fire-and-forget)
      trackUsage(
        c.env,
        apiKeyHash,
        tier,
        "/export/backtest",
        result.data.length
      ).catch(() => {});

      return c.json({
        data: result.data,
        rows: result.data.length,
        asset_id: assetId,
        granularity,
        start,
        end,
        tier,
        format: "json", // Pro tier always gets JSON
      });
    } catch (error) {
      console.error(
        `[Backtest] Export failed for asset ${assetId.slice(0, 20)}... ` +
        `(${start} to ${end}, granularity: ${granularity}):`,
        error
      );
      return c.json({ error: "Export failed", details: String(error) }, 500);
    }
  }
);

/**
 * Bulk export for Team/Business tiers
 * Returns presigned URLs for direct Parquet download
 *
 * GET /export/bulk/:condition_id
 * Query params:
 *   - start: Optional. Start date (ISO 8601).
 *   - end: Optional. End date (ISO 8601).
 *   - format: Optional. "parquet" (default), "csv", or "json".
 */
backtest.get(
  "/export/bulk/:condition_id",
  tierEnforcement("full"),
  dateRangeEnforcement,
  async (c) => {
    const { tier } = await getTierInfo(c);
    const tierLimits = TIER_LIMITS[tier];
    const conditionId = c.req.param("condition_id");
    const format = c.req.query("format") || "parquet";
    const startStr = c.req.query("start");
    const endStr = c.req.query("end");

    // Validate format for tier
    const validFormats = tierLimits.exportFormats as readonly string[];
    if (!validFormats.includes(format)) {
      return c.json({
        error: "Export format not available",
        message: `Your ${tier} tier supports: ${tierLimits.exportFormats.join(", ")}`,
        requested_format: format,
      }, 403);
    }

    const queryService = new ArchiveQueryService(c.env);

    try {
      const result = await queryService.generateBulkExport(conditionId, {
        tier,
        format: format as ExportFormat,
        startDate: startStr ? new Date(startStr) : undefined,
        endDate: endStr ? new Date(endStr) : undefined,
      });

      return c.json({
        success: true,
        condition_id: conditionId,
        ...result,
      });
    } catch (error) {
      console.error(`[Backtest] Bulk export failed for ${conditionId}:`, error);
      return c.json({ error: "Bulk export failed", details: String(error) }, 500);
    }
  }
);

/**
 * Get available assets for backtesting.
 *
 * GET /export/assets
 * Query params:
 *   - min_ticks: Optional. Minimum tick count (default 1000).
 *   - limit: Optional. Max assets to return (default 100).
 *
 * Returns list of assets with tick counts for backtesting.
 */
backtest.get("/export/assets", tierEnforcement("read"), async (c) => {
  const { tier } = await getTierInfo(c);
  const minTicks = parseInt(c.req.query("min_ticks") || "1000", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 1000);

  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
  };

  const query = `
    SELECT
      asset_id,
      condition_id,
      count() AS total_ticks,
      min(source_ts) AS first_tick,
      max(source_ts) AS last_tick,
      dateDiff('day', min(source_ts), max(source_ts)) AS days_of_data
    FROM ${DB_CONFIG.DATABASE}.ob_bbo
    GROUP BY asset_id, condition_id
    HAVING total_ticks >= ${minTicks}
    ORDER BY total_ticks DESC
    LIMIT ${limit}
    FORMAT JSON
  `;

  try {
    const response = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`,
      { method: "GET", headers }
    );

    if (!response.ok) {
      const error = await response.text();
      return c.json({ error: "Query failed", details: error }, 500);
    }

    const result = (await response.json()) as {
      data: Array<{
        asset_id: string;
        condition_id: string;
        total_ticks: number;
        first_tick: string;
        last_tick: string;
        days_of_data: number;
      }>;
    };

    return c.json({
      assets: result.data,
      count: result.data.length,
      min_ticks_filter: minTicks,
      tier,
    });
  } catch (error) {
    console.error(
      `[Backtest] Assets query failed (min_ticks: ${minTicks}, limit: ${limit}):`,
      error
    );
    return c.json({ error: "Query failed", details: String(error) }, 500);
  }
});

/**
 * Get data quality metrics for an asset.
 *
 * GET /export/quality/:asset_id
 *
 * Returns data quality metrics useful for backtest validation.
 */
backtest.get("/export/quality/:asset_id", tierEnforcement("read"), async (c) => {
  const assetId = c.req.param("asset_id");

  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
  };

  // Use parameterized query to prevent SQL injection
  const query = `
    SELECT
      count() AS total_ticks,
      min(source_ts) AS first_tick,
      max(source_ts) AS last_tick,
      quantiles(0.5, 0.95, 0.99)(
        dateDiff('millisecond', source_ts, ingestion_ts)
      ) AS latency_percentiles,
      countIf(is_resync = 1) AS resync_count,
      max(sequence_number) - min(sequence_number) + 1 AS expected_sequence_range,
      count(DISTINCT sequence_number) AS unique_sequences,
      1 - (count(DISTINCT sequence_number) / (max(sequence_number) - min(sequence_number) + 1)) AS sequence_gap_ratio
    FROM ${DB_CONFIG.DATABASE}.ob_bbo
    WHERE asset_id = {asset_id:String}
    FORMAT JSON
  `;

  try {
    const url = new URL(c.env.CLICKHOUSE_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("param_asset_id", assetId);

    const response = await fetch(url.toString(), { method: "GET", headers });

    if (!response.ok) {
      const error = await response.text();
      return c.json({ error: "Query failed", details: error }, 500);
    }

    const result = (await response.json()) as { data: Record<string, unknown>[] };

    if (result.data.length === 0) {
      return c.json({ error: "No data found for asset" }, 404);
    }

    return c.json({
      asset_id: assetId,
      quality: result.data[0],
    });
  } catch (error) {
    console.error(
      `[Backtest] Quality query failed for asset ${assetId.slice(0, 20)}...:`,
      error
    );
    return c.json({ error: "Query failed", details: String(error) }, 500);
  }
});

// ============================================================
// Usage Tracking Endpoints
// ============================================================

/**
 * Get usage summary for the current billing cycle.
 *
 * GET /usage
 *
 * Returns usage statistics and estimated costs.
 */
backtest.get("/usage", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const summary = await getUsageSummary(c.env, apiKey);

    return c.json({
      success: true,
      usage: summary,
      tier_limits: TIER_LIMITS[summary.tier],
    });
  } catch (error) {
    console.error("[Backtest] Usage query failed:", error);
    return c.json({ error: "Failed to get usage", details: String(error) }, 500);
  }
});

/**
 * Get tier information and limits.
 *
 * GET /tier
 *
 * Returns current tier and its limits.
 */
backtest.get("/tier", async (c) => {
  const { tier } = await getTierInfo(c);
  const tierLimits = TIER_LIMITS[tier];

  return c.json({
    tier,
    limits: {
      historical_days: tierLimits.historicalDays === Infinity ? "unlimited" : tierLimits.historicalDays,
      backtest_access: tierLimits.backtestAccess,
      export_formats: tierLimits.exportFormats,
      overage_rate: tierLimits.overageRate,
    },
    all_tiers: Object.entries(TIER_LIMITS).map(([name, limits]) => ({
      name,
      historical_days: limits.historicalDays === Infinity ? "unlimited" : limits.historicalDays,
      backtest_access: limits.backtestAccess,
      export_formats: limits.exportFormats,
    })),
  });
});

export { backtest };
