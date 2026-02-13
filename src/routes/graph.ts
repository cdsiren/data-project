// src/routes/graph.ts
// Graph API endpoints for market relationship queries

import { Hono, Context, Next } from "hono";
import type { Env } from "../types";
import { GraphCacheService, formatEdgeReason, executeCorrelationSeeding } from "../services/graph/graph-cache";
import type {
  GraphNeighbor,
  NeighborResponse,
  PathResponse,
  ArbitrageResponse,
  CyclesResponse,
  SuggestionsResponse,
  MarketSuggestion,
} from "../services/graph/types";

/**
 * Extended Durable Object namespace with location hint support.
 */
interface DurableObjectNamespaceExt {
  idFromName(name: string, options?: { locationHint?: DurableObjectLocationHint }): DurableObjectId;
}

/**
 * Get GraphManager DO stub.
 */
function getGraphManagerStub(env: Env): DurableObjectStub {
  const ns = env.GRAPH_MANAGER as unknown as DurableObjectNamespaceExt;
  const doId = ns.idFromName("global", { locationHint: "weur" });
  return env.GRAPH_MANAGER.get(doId);
}

/**
 * Auth middleware for graph API endpoints.
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
// Input Validation Helpers
// ============================================================

/**
 * Valid edge types for filtering.
 */
const VALID_EDGE_TYPES = ["correlation", "hedge", "causal", "arbitrage"] as const;
type ValidEdgeType = typeof VALID_EDGE_TYPES[number];

/**
 * Parse and validate a numeric query parameter with bounds.
 * Returns defaultValue for invalid/missing inputs.
 */
function parseNumber(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (!value) return defaultValue;

  const parsed = Number(value);

  // Check for NaN, Infinity, -Infinity
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.max(min, Math.min(max, parsed));
}

/**
 * Parse and validate edge types parameter.
 * Returns undefined if not provided, or filtered array of valid edge types.
 */
function parseEdgeTypes(value: string | undefined): ValidEdgeType[] | undefined {
  if (!value) return undefined;

  const types = value.split(",").filter((t): t is ValidEdgeType =>
    VALID_EDGE_TYPES.includes(t as ValidEdgeType)
  );

  return types.length > 0 ? types : undefined;
}

// Create Hono app for graph routes
export const graphRouter = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
graphRouter.use("*", authMiddleware);

// ============================================================
// Graph Health & Status
// ============================================================

/**
 * GET /api/graph/health
 * Health check for graph system.
 */
graphRouter.get("/health", async (c) => {
  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/health");
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

/**
 * GET /api/graph/stats
 * Graph statistics (market count, edge count, etc.).
 */
graphRouter.get("/stats", async (c) => {
  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/stats");
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Neighbor Queries
// ============================================================

/**
 * GET /api/graph/neighbors/:marketId
 * Get 1-hop neighbors for a market.
 *
 * Query params:
 * - min_weight: Minimum edge weight (default: 0)
 * - limit: Maximum neighbors to return (default: 50)
 * - edge_types: Comma-separated list of edge types to include
 */
graphRouter.get("/neighbors/:marketId", async (c) => {
  const marketId = c.req.param("marketId");
  const minWeight = parseNumber(c.req.query("min_weight"), 0, 0, 1000);
  const limit = parseNumber(c.req.query("limit"), 50, 1, 1000);
  const edgeTypes = parseEdgeTypes(c.req.query("edge_types"));

  try {
    // Try KV cache first
    const cacheService = new GraphCacheService(c.env.GRAPH_CACHE);
    let neighbors = await cacheService.getNeighbors(marketId);
    let cached = true;

    // Fall back to GraphManager DO
    if (!neighbors) {
      const stub = getGraphManagerStub(c.env);
      const response = await stub.fetch(`http://do/neighbors/${marketId}`);
      const data = await response.json() as { neighbors: GraphNeighbor[] };
      neighbors = data.neighbors;
      cached = false;

      // Cache for future requests
      if (neighbors && neighbors.length > 0) {
        await cacheService.setNeighbors(marketId, neighbors);
      }
    }

    // Apply filters
    let filtered = neighbors || [];

    if (minWeight > 0) {
      filtered = filtered.filter(n => Math.abs(n.weight) >= minWeight);
    }

    if (edgeTypes) {
      filtered = filtered.filter(n => edgeTypes.includes(n.edge_type));
    }

    // Sort by weight (descending) and limit
    filtered = filtered
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, limit);

    const response: NeighborResponse = {
      market_id: marketId,
      neighbors: filtered,
      cached,
      updated_at: Date.now(),
    };

    return c.json(response);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Path Finding
// ============================================================

/**
 * GET /api/graph/paths/:from/:to
 * Find shortest path between two markets.
 */
graphRouter.get("/paths/:from/:to", async (c) => {
  const from = c.req.param("from");
  const to = c.req.param("to");

  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });

    const data = await response.json() as PathResponse;
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Arbitrage Detection
// ============================================================

/**
 * GET /api/graph/arbitrage/:marketId
 * Find arbitrage paths from a market.
 *
 * Query params:
 * - max_depth: Maximum path depth (default: 2)
 * - min_weight: Minimum edge weight (default: 0.5)
 * - limit: Maximum paths to return (default: 10)
 */
graphRouter.get("/arbitrage/:marketId", async (c) => {
  const marketId = c.req.param("marketId");
  const maxDepth = parseNumber(c.req.query("max_depth"), 2, 1, 5);
  const minWeight = parseNumber(c.req.query("min_weight"), 0.5, 0, 1000);
  const limit = parseNumber(c.req.query("limit"), 10, 1, 100);

  try {
    const stub = getGraphManagerStub(c.env);
    const queryParams = new URLSearchParams({
      max_depth: String(maxDepth),
      min_weight: String(minWeight),
      limit: String(limit),
    });
    const response = await stub.fetch(`http://do/arbitrage/${marketId}?${queryParams}`);

    const data = await response.json() as ArbitrageResponse;
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Negative Cycle Detection
// ============================================================

/**
 * GET /api/graph/cycles
 * Get detected negative cycles (arbitrage opportunities).
 */
graphRouter.get("/cycles", async (c) => {
  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/cycles");
    const data = await response.json() as CyclesResponse;
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

/**
 * POST /api/graph/detect-cycles
 * Manually trigger cycle detection.
 */
graphRouter.post("/detect-cycles", async (c) => {
  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/detect-cycles", {
      method: "POST",
    });
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Top Edges
// ============================================================

/**
 * GET /api/graph/top-edges
 * Get strongest edges across the entire graph.
 *
 * Query params:
 * - limit: Maximum edges to return (default: 100)
 * - edge_type: Filter by edge type
 */
graphRouter.get("/top-edges", async (c) => {
  const limitParam = parseInt(c.req.query("limit") || "100");
  // Validate limit is a finite number within bounds
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 1000) : 100;
  const edgeType = c.req.query("edge_type");

  // Whitelist valid edge types - using a Map for O(1) lookup and safe value retrieval
  const VALID_EDGE_TYPES: Record<string, string> = {
    correlation: "correlation",
    hedge: "hedge",
    causal: "causal",
    arbitrage: "arbitrage",
  };

  try {
    // Validate and safely retrieve edge_type from whitelist
    // This completely avoids string interpolation by only using pre-defined values
    let typeFilter = "";
    if (edgeType) {
      const safeEdgeType = VALID_EDGE_TYPES[edgeType];
      if (!safeEdgeType) {
        return c.json({ error: `Invalid edge_type. Must be one of: ${Object.keys(VALID_EDGE_TYPES).join(", ")}` }, 400);
      }
      // Use the whitelist value, not the user input
      typeFilter = `AND edge_type = '${safeEdgeType}'`;
    }

    const query = `
      SELECT
        market_a,
        market_b,
        edge_type,
        weight,
        user_count,
        signal_count,
        last_signal_at
      FROM trading_data.graph_edges FINAL
      WHERE weight > 0.1 ${typeFilter}
      ORDER BY weight DESC
      LIMIT ${limit}
      FORMAT JSONEachRow
    `;

    const response = await fetch(c.env.CLICKHOUSE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
        "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
      },
      body: query,
    });

    if (!response.ok) {
      throw new Error(`ClickHouse error: ${await response.text()}`);
    }

    const text = await response.text();
    const edges = text.trim()
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line));

    return c.json({
      edges,
      count: edges.length,
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Market Suggestions
// ============================================================

/**
 * GET /api/graph/suggestions/:marketId
 * Get suggested related markets based on graph edges.
 * Useful for analysis builder and trigger creation UI.
 *
 * Query params:
 * - limit: Maximum suggestions (default: 10)
 * - min_user_count: Minimum users who linked markets (default: 2)
 */
graphRouter.get("/suggestions/:marketId", async (c) => {
  const marketId = c.req.param("marketId");
  const limit = parseNumber(c.req.query("limit"), 10, 1, 100);
  const minUserCount = parseNumber(c.req.query("min_user_count"), 2, 0, 1000);

  try {
    // Get neighbors sorted by user_count and weight
    const cacheService = new GraphCacheService(c.env.GRAPH_CACHE);
    const neighbors = await cacheService.getNeighborsSorted(marketId, {
      minWeight: 0.3,
      minUserCount,
      limit,
    });

    // If not in cache, fetch from GraphManager
    let finalNeighbors = neighbors;
    if (neighbors.length === 0) {
      const stub = getGraphManagerStub(c.env);
      const response = await stub.fetch(`http://do/neighbors/${marketId}`);
      const data = await response.json() as { neighbors: GraphNeighbor[] };

      finalNeighbors = (data.neighbors || [])
        .filter(n => n.user_count >= minUserCount && Math.abs(n.weight) >= 0.3)
        .sort((a, b) => b.user_count - a.user_count || Math.abs(b.weight) - Math.abs(a.weight))
        .slice(0, limit);
    }

    // Enrich with market metadata (if available)
    const suggestions: MarketSuggestion[] = await Promise.all(
      finalNeighbors.map(async (n) => {
        // Try to get market metadata from KV cache
        let market: MarketSuggestion["market"] | undefined;
        try {
          const cached = await c.env.MARKET_CACHE.get(`market_${n.market_id}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            market = {
              title: parsed.title,
              question: parsed.question,
              end_date: parsed.end_date_iso,
            };
          }
        } catch {
          // Ignore cache miss
        }

        return {
          market_id: n.market_id,
          edge_type: n.edge_type,
          weight: n.weight,
          user_count: n.user_count,
          reason: formatEdgeReason(n),
          market,
        };
      })
    );

    const totalUserCount = finalNeighbors.reduce((sum, n) => sum + n.user_count, 0);

    const response: SuggestionsResponse = {
      market_id: marketId,
      suggestions,
      community_signal: `Built from ${totalUserCount} user analyses`,
    };

    return c.json(response);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// N-Hop Neighbors
// ============================================================

/**
 * GET /api/graph/nhop/:marketId/:hops
 * Get N-hop neighbors from a market.
 *
 * @param marketId - Starting market ID
 * @param hops - Number of hops (1-3, default 2)
 */
graphRouter.get("/nhop/:marketId/:hops?", async (c) => {
  const marketId = c.req.param("marketId");
  // parseNumber enforces bounds, so separate validation not needed
  const hops = parseNumber(c.req.param("hops"), 2, 1, 3);

  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch(`http://do/nhop/${marketId}/${hops}`);
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// ============================================================
// Admin Endpoints
// ============================================================

/**
 * POST /api/graph/rebuild
 * Manually trigger graph rebuild from ClickHouse.
 */
graphRouter.post("/rebuild", async (c) => {
  try {
    const stub = getGraphManagerStub(c.env);
    const response = await stub.fetch("http://do/rebuild", {
      method: "POST",
    });
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

/**
 * POST /api/graph/seed-correlation
 * Manually trigger correlation seeding cron.
 */
graphRouter.post("/seed-correlation", async (c) => {
  try {
    await executeCorrelationSeeding(
      c.env.CLICKHOUSE_URL,
      c.env.CLICKHOUSE_USER,
      c.env.CLICKHOUSE_TOKEN
    );

    return c.json({ status: "seeded", timestamp: new Date().toISOString() });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

/**
 * GET /api/graph/test-correlation
 * Test the correlation seeding query without inserting.
 * Returns first 10 correlated pairs that would be seeded.
 */
graphRouter.get("/test-correlation", async (c) => {
  try {
    // Same query as seeding but SELECT only, with LIMIT
    // Note: mid_price is Decimal(18,6), must cast to Float64 for corr()
    const testQuery = `
      SELECT
        a.condition_id AS market_a,
        b.condition_id AS market_b,
        abs(corr(toFloat64(a.mid_price), toFloat64(b.mid_price))) AS correlation_strength,
        count() as data_points
      FROM trading_data.ob_bbo a
      JOIN trading_data.ob_bbo b ON a.ingestion_ts = b.ingestion_ts
      WHERE a.condition_id < b.condition_id
        AND a.ingestion_ts > now() - INTERVAL 7 DAY
      GROUP BY a.condition_id, b.condition_id
      HAVING abs(corr(toFloat64(a.mid_price), toFloat64(b.mid_price))) > 0.6
      ORDER BY correlation_strength DESC
      LIMIT 20
      FORMAT JSONEachRow
      SETTINGS max_execution_time = 120
    `;

    const headers = {
      "Content-Type": "text/plain",
      "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
    };

    const startTime = Date.now();
    const response = await fetch(c.env.CLICKHOUSE_URL, {
      method: "POST",
      headers,
      body: testQuery,
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return c.json({
        error: "Query failed",
        status: response.status,
        message: errorText,
        elapsed_ms: elapsed,
      }, 500);
    }

    const text = await response.text();
    const pairs = text.trim()
      ? text.trim().split("\n").map(line => JSON.parse(line))
      : [];

    return c.json({
      status: "ok",
      elapsed_ms: elapsed,
      found_pairs: pairs.length,
      sample_pairs: pairs,
      note: pairs.length === 0
        ? "No market pairs with correlation > 0.6 found in last 7 days"
        : `Found ${pairs.length} highly correlated market pairs (showing top 20)`,
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

/**
 * GET /api/graph/debug
 * Debug endpoint to check graph cron state.
 * Returns KV values, last rebuild timestamp, and signal counts.
 */
graphRouter.get("/debug", async (c) => {
  try {
    // Check last correlation seed timestamp
    const lastSeedKey = "graph:last_correlation_seed";
    const lastSeedValue = await c.env.GRAPH_CACHE.get(lastSeedKey);
    const lastSeedTimestamp = lastSeedValue ? parseInt(lastSeedValue) : null;
    const lastSeedDate = lastSeedTimestamp ? new Date(lastSeedTimestamp).toISOString() : null;

    // Check rebuild timestamp from cache service
    const cacheService = new GraphCacheService(c.env.GRAPH_CACHE);
    const rebuildTimestamp = await cacheService.getRebuildTimestamp();
    const rebuildDate = rebuildTimestamp ? new Date(rebuildTimestamp).toISOString() : null;

    // Query ClickHouse for signal counts
    const signalCountQuery = `
      SELECT
        signal_source,
        edge_type,
        count() as count,
        min(created_at) as oldest,
        max(created_at) as newest
      FROM trading_data.graph_edge_signals
      GROUP BY signal_source, edge_type
      ORDER BY count DESC
      FORMAT JSONEachRow
    `;

    const edgeCountQuery = `
      SELECT count() as count FROM trading_data.graph_edges FINAL
      FORMAT JSONEachRow
    `;

    const headers = {
      "Content-Type": "text/plain",
      "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
    };

    const [signalResponse, edgeResponse] = await Promise.all([
      fetch(c.env.CLICKHOUSE_URL, { method: "POST", headers, body: signalCountQuery }),
      fetch(c.env.CLICKHOUSE_URL, { method: "POST", headers, body: edgeCountQuery }),
    ]);

    const signalText = await signalResponse.text();
    const edgeText = await edgeResponse.text();

    const signalCounts = signalText.trim()
      ? signalText.trim().split("\n").map(line => JSON.parse(line))
      : [];

    const edgeCount = edgeText.trim()
      ? JSON.parse(edgeText.trim()).count
      : 0;

    // Get GraphManager status
    const stub = getGraphManagerStub(c.env);
    const statusResponse = await stub.fetch("http://do/status");
    const doStatus = await statusResponse.json();

    return c.json({
      cron_state: {
        last_correlation_seed: lastSeedDate,
        last_correlation_seed_ms: lastSeedTimestamp,
        seed_age_hours: lastSeedTimestamp
          ? ((Date.now() - lastSeedTimestamp) / (1000 * 60 * 60)).toFixed(2)
          : null,
        needs_seeding: !lastSeedTimestamp || (Date.now() - lastSeedTimestamp) > 24 * 60 * 60 * 1000,
      },
      kv_cache: {
        last_rebuild: rebuildDate,
        last_rebuild_ms: rebuildTimestamp,
        rebuild_age_minutes: rebuildTimestamp
          ? ((Date.now() - rebuildTimestamp) / (1000 * 60)).toFixed(2)
          : null,
      },
      clickhouse: {
        signal_counts: signalCounts,
        total_signals: signalCounts.reduce((sum: number, s: { count: number }) => sum + s.count, 0),
        aggregated_edge_count: edgeCount,
      },
      graph_manager: doStatus,
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});
