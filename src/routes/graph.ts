// src/routes/graph.ts
// Graph API endpoints for market relationship queries

import { Hono, Context, Next } from "hono";
import type { Env } from "../types";
import { GraphCacheService, formatEdgeReason } from "../services/graph/graph-cache";
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
  const minWeight = parseFloat(c.req.query("min_weight") || "0");
  const limit = parseInt(c.req.query("limit") || "50");
  const edgeTypesParam = c.req.query("edge_types");
  const edgeTypes = edgeTypesParam ? edgeTypesParam.split(",") : undefined;

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
  const maxDepth = c.req.query("max_depth") || "2";
  const minWeight = c.req.query("min_weight") || "0.5";
  const limit = c.req.query("limit") || "10";

  try {
    const stub = getGraphManagerStub(c.env);
    const queryParams = new URLSearchParams({
      max_depth: maxDepth,
      min_weight: minWeight,
      limit,
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
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") || "100")), 1000);
  const edgeType = c.req.query("edge_type");

  // Whitelist valid edge types to prevent SQL injection
  const VALID_EDGE_TYPES = ["correlation", "hedge", "causal", "arbitrage"] as const;

  try {
    // Validate edge_type against whitelist
    let typeFilter = "";
    if (edgeType) {
      if (!VALID_EDGE_TYPES.includes(edgeType as typeof VALID_EDGE_TYPES[number])) {
        return c.json({ error: `Invalid edge_type. Must be one of: ${VALID_EDGE_TYPES.join(", ")}` }, 400);
      }
      typeFilter = `AND edge_type = '${edgeType}'`;
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
  const limit = parseInt(c.req.query("limit") || "10");
  const minUserCount = parseInt(c.req.query("min_user_count") || "2");

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
  const hops = parseInt(c.req.param("hops") || "2");

  if (hops < 1 || hops > 3) {
    return c.json({ error: "hops must be between 1 and 3" }, 400);
  }

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
    // Run the correlation seeding query directly
    const correlationQuery = `
      INSERT INTO trading_data.graph_edge_signals
      SELECT
          a.condition_id AS market_a,
          b.condition_id AS market_b,
          'correlation' AS edge_type,
          'cron_correlation' AS signal_source,
          '' AS user_id,
          abs(corr(a.mid_price, b.mid_price)) AS strength,
          '' AS metadata,
          now64(6) AS created_at,
          today() AS created_date
      FROM trading_data.ob_bbo a
      JOIN trading_data.ob_bbo b ON a.ingestion_ts = b.ingestion_ts
      WHERE a.condition_id < b.condition_id
        AND a.ingestion_ts > now() - INTERVAL 7 DAY
      GROUP BY a.condition_id, b.condition_id
      HAVING abs(corr(a.mid_price, b.mid_price)) > 0.6
    `;

    const response = await fetch(c.env.CLICKHOUSE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
        "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
      },
      body: correlationQuery,
    });

    if (!response.ok) {
      throw new Error(`ClickHouse error: ${await response.text()}`);
    }

    // Also run hedge seeding
    const hedgeQuery = `
      INSERT INTO trading_data.graph_edge_signals
      SELECT
          a.condition_id AS market_a,
          b.condition_id AS market_b,
          'hedge' AS edge_type,
          'cron_correlation' AS signal_source,
          '' AS user_id,
          abs(corr(a.mid_price, b.mid_price)) AS strength,
          '' AS metadata,
          now64(6) AS created_at,
          today() AS created_date
      FROM trading_data.ob_bbo a
      JOIN trading_data.ob_bbo b ON a.ingestion_ts = b.ingestion_ts
      WHERE a.condition_id < b.condition_id
        AND a.ingestion_ts > now() - INTERVAL 7 DAY
      GROUP BY a.condition_id, b.condition_id
      HAVING corr(a.mid_price, b.mid_price) < -0.5
    `;

    await fetch(c.env.CLICKHOUSE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
        "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
      },
      body: hedgeQuery,
    });

    return c.json({ status: "seeded", timestamp: new Date().toISOString() });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});
