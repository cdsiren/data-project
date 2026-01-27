// src/routes/backtest.ts
// Backtest data export endpoints for historical data queries

import { Hono, Context, Next } from "hono";
import type { Env } from "../types";
import { DB_CONFIG } from "../config/database";

const backtest = new Hono<{ Bindings: Env }>();

/**
 * Auth middleware for backtest API
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

backtest.use("*", authMiddleware);

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
 * Response:
 *   - data: Array of records
 *   - rows: Number of records returned
 *   - asset_id: Requested asset ID
 *   - granularity: Data granularity
 *   - start: Start date used
 *   - end: End date used
 */
backtest.get("/export/backtest", async (c) => {
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

    return c.json({
      data: result.data,
      rows: result.data.length,
      asset_id: assetId,
      granularity,
      start,
      end,
    });
  } catch (error) {
    return c.json({ error: "Export failed", details: String(error) }, 500);
  }
});

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
backtest.get("/export/assets", async (c) => {
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
    });
  } catch (error) {
    return c.json({ error: "Query failed", details: String(error) }, 500);
  }
});

/**
 * Get data quality metrics for an asset.
 *
 * GET /export/quality/:asset_id
 *
 * Returns data quality metrics useful for backtest validation:
 * - Gap counts
 * - Sequence continuity
 * - Latency percentiles
 */
backtest.get("/export/quality/:asset_id", async (c) => {
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
    return c.json({ error: "Query failed", details: String(error) }, 500);
  }
});

export { backtest };
