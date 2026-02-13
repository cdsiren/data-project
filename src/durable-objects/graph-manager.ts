// src/durable-objects/graph-manager.ts
// GraphManager Durable Object - Authoritative graph state for market relationships
// Tier 1 of the hybrid three-tier graph architecture

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  GraphNeighbor,
  GraphEdge,
  NegativeCycle,
  ArbitragePath,
  ShortestPath,
  GraphQueryOptions,
  GraphManagerState,
} from "../services/graph/types";
import {
  findArbitragePaths,
  detectNegativeCycles,
  findShortestPath,
  calculateGraphStats,
  getNHopNeighbors,
} from "../services/graph/graph-algorithms";
import { GraphCacheService } from "../services/graph/graph-cache";

/**
 * Stored state for persistence across hibernation.
 */
interface StoredGraphState {
  lastRebuild: number;
  edgeCount: number;
  marketCount: number;
  lastCycleDetection: number;
  cachedCycles: NegativeCycle[];
}

/**
 * GraphManager Durable Object
 *
 * Responsibilities:
 * - Maintains authoritative graph state rebuilt from ClickHouse every 15 min
 * - Serves complex graph queries (BFS, Bellman-Ford)
 * - Runs negative cycle detection for arbitrage alerts
 * - Syncs adjacency lists to KV cache for hot path access
 *
 * Memory target: ~50MB for 10K markets, 100K edges
 */
export class GraphManager extends DurableObject<Env> {
  // In-memory graph state
  private adjacencyList: Map<string, GraphNeighbor[]> = new Map();

  // Rebuild tracking
  private lastRebuild: number = 0;
  private isRebuilding: boolean = false;

  // Cycle detection cache
  private cachedCycles: NegativeCycle[] = [];
  private lastCycleDetection: number = 0;

  // Stats
  private edgeCount: number = 0;
  private marketCount: number = 0;

  // Cache service for KV sync
  private cacheService: GraphCacheService | null = null;

  // Rebuild interval (15 minutes)
  private readonly REBUILD_INTERVAL_MS = 15 * 60 * 1000;
  // Cycle detection interval (same as rebuild for now)
  private readonly CYCLE_DETECTION_INTERVAL_MS = 15 * 60 * 1000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state on wake
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const stored = await this.ctx.storage.get<StoredGraphState>("graphState");

        if (stored) {
          this.lastRebuild = stored.lastRebuild || 0;
          this.edgeCount = stored.edgeCount || 0;
          this.marketCount = stored.marketCount || 0;
          this.lastCycleDetection = stored.lastCycleDetection || 0;
          this.cachedCycles = stored.cachedCycles || [];

          console.log(
            `[GraphManager] Restored state: ${this.marketCount} markets, ${this.edgeCount} edges, ` +
            `last rebuild: ${new Date(this.lastRebuild).toISOString()}`
          );
        }

        // Schedule alarm for next rebuild if needed
        const nextRebuild = this.lastRebuild + this.REBUILD_INTERVAL_MS;
        if (Date.now() >= nextRebuild) {
          // Rebuild now
          await this.ctx.storage.setAlarm(Date.now() + 1000);
        } else {
          // Schedule for next interval
          await this.ctx.storage.setAlarm(nextRebuild);
        }
      } catch (error) {
        console.error("[GraphManager] Error restoring state:", error);
      }
    });
  }

  /**
   * Get or create the cache service.
   */
  private getCacheService(): GraphCacheService {
    if (!this.cacheService) {
      this.cacheService = new GraphCacheService(this.env.GRAPH_CACHE);
    }
    return this.cacheService;
  }

  /**
   * Handle HTTP requests to the GraphManager DO.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === "/health") {
        return Response.json({
          status: "ok",
          last_rebuild: this.lastRebuild,
          market_count: this.marketCount,
          edge_count: this.edgeCount,
          rebuild_age_ms: Date.now() - this.lastRebuild,
        });
      }

      // Get status
      if (path === "/status") {
        return Response.json({
          market_count: this.marketCount,
          edge_count: this.edgeCount,
          last_rebuild: this.lastRebuild,
          last_cycle_detection: this.lastCycleDetection,
          cached_cycles: this.cachedCycles.length,
          is_rebuilding: this.isRebuilding,
        });
      }

      // Get neighbors for a market
      if (path.startsWith("/neighbors/")) {
        const marketId = path.replace("/neighbors/", "");
        const neighbors = this.adjacencyList.get(marketId) || [];
        return Response.json({ market_id: marketId, neighbors });
      }

      // Get full graph (for internal use only)
      if (path === "/graph") {
        const graph: Record<string, GraphNeighbor[]> = {};
        for (const [key, value] of this.adjacencyList) {
          graph[key] = value;
        }
        return Response.json({
          graph,
          market_count: this.marketCount,
          edge_count: this.edgeCount,
        });
      }

      // Find arbitrage paths
      if (path.startsWith("/arbitrage/")) {
        const marketId = path.replace("/arbitrage/", "");
        const maxDepth = parseInt(url.searchParams.get("max_depth") || "2");
        const minWeight = parseFloat(url.searchParams.get("min_weight") || "0.5");
        const limit = parseInt(url.searchParams.get("limit") || "10");

        const paths = findArbitragePaths(marketId, this.adjacencyList, {
          maxDepth,
          minWeight,
          limit,
        });

        return Response.json({
          market_id: marketId,
          paths,
          count: paths.length,
        });
      }

      // Find shortest path
      if (path === "/path" && request.method === "POST") {
        const body = await request.json() as { from: string; to: string };
        const { from, to } = body;

        const result = findShortestPath(from, to, this.adjacencyList);
        return Response.json({
          from,
          to,
          path: result,
          found: result !== null,
        });
      }

      // Get cached cycles
      if (path === "/cycles") {
        return Response.json({
          cycles: this.cachedCycles,
          count: this.cachedCycles.length,
          last_detection: this.lastCycleDetection,
        });
      }

      // Run cycle detection manually
      if (path === "/detect-cycles" && request.method === "POST") {
        const cycles = await this.runCycleDetection();
        return Response.json({
          cycles,
          count: cycles.length,
        });
      }

      // Trigger rebuild manually
      if (path === "/rebuild" && request.method === "POST") {
        await this.rebuildGraph();
        return Response.json({
          status: "rebuilt",
          market_count: this.marketCount,
          edge_count: this.edgeCount,
        });
      }

      // Get graph statistics
      if (path === "/stats") {
        const stats = calculateGraphStats(this.adjacencyList);
        return Response.json(stats);
      }

      // Get N-hop neighbors
      if (path.startsWith("/nhop/")) {
        const rest = path.replace("/nhop/", "");
        const parts = rest.split("/");
        const marketId = parts[0];
        const hops = parseInt(parts[1] || "2");

        const neighbors = getNHopNeighbors(marketId, this.adjacencyList, hops);
        const result: Record<string, { distance: number; path: string[] }> = {};
        for (const [key, value] of neighbors) {
          result[key] = value;
        }

        return Response.json({
          market_id: marketId,
          hops,
          neighbors: result,
          count: neighbors.size,
        });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      console.error("[GraphManager] Request error:", error);
      return Response.json(
        { error: String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle scheduled alarm for periodic rebuild.
   */
  async alarm(): Promise<void> {
    console.log("[GraphManager] Alarm triggered, starting rebuild");

    try {
      await this.rebuildGraph();

      // Run cycle detection after rebuild
      await this.runCycleDetection();

      // Schedule next alarm
      await this.ctx.storage.setAlarm(Date.now() + this.REBUILD_INTERVAL_MS);
    } catch (error) {
      console.error("[GraphManager] Alarm error:", error);
      // Retry in 1 minute on error
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }

  /**
   * Rebuild the graph from ClickHouse.
   * Uses DO storage for atomic locking to prevent concurrent rebuilds.
   */
  async rebuildGraph(): Promise<void> {
    // Use DO storage for atomic rebuild lock (prevents race conditions)
    const LOCK_KEY = "rebuild:lock";
    const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes max rebuild time

    const existingLock = await this.ctx.storage.get<number>(LOCK_KEY);
    const now = Date.now();

    // Check if lock exists and hasn't expired
    if (existingLock && (now - existingLock) < LOCK_TTL_MS) {
      console.log("[GraphManager] Rebuild already in progress (locked), skipping");
      return;
    }

    // Acquire lock atomically via DO storage
    await this.ctx.storage.put(LOCK_KEY, now);
    this.isRebuilding = true;
    console.log("[GraphManager] Starting graph rebuild from ClickHouse");

    try {
      // First, run the aggregation query to update graph_edges
      await this.runAggregationQuery();

      // Then fetch the aggregated edges
      const edges = await this.fetchEdgesFromClickHouse();

      // CRITICAL: Preserve existing graph data if fetch returned empty due to error
      // An empty result from a working ClickHouse is valid (no edges above threshold),
      // but we distinguish this by checking if we had data before and got nothing back.
      // If we had a populated graph and get empty results, it's likely a transient error.
      if (edges.length === 0 && this.adjacencyList.size > 0) {
        console.warn(
          `[GraphManager] Fetch returned 0 edges but graph has ${this.adjacencyList.size} markets. ` +
          `Preserving existing data to avoid data loss from transient ClickHouse errors.`
        );
        return;
      }

      // Build adjacency list with optimized Map access
      // Cache array references to reduce Map.get() calls from 4 to 2 per edge
      const newAdjacencyList = new Map<string, GraphNeighbor[]>();

      for (const edge of edges) {
        // Create neighbor objects once
        const forwardNeighbor: GraphNeighbor = {
          market_id: edge.market_b,
          edge_type: edge.edge_type as GraphNeighbor["edge_type"],
          weight: edge.weight,
          user_count: edge.user_count,
        };
        const reverseNeighbor: GraphNeighbor = {
          market_id: edge.market_a,
          edge_type: edge.edge_type as GraphNeighbor["edge_type"],
          weight: edge.weight,
          user_count: edge.user_count,
        };

        // Get or create forward list (cache reference)
        let forwardList = newAdjacencyList.get(edge.market_a);
        if (!forwardList) {
          forwardList = [];
          newAdjacencyList.set(edge.market_a, forwardList);
        }
        forwardList.push(forwardNeighbor);

        // Get or create reverse list (cache reference)
        let reverseList = newAdjacencyList.get(edge.market_b);
        if (!reverseList) {
          reverseList = [];
          newAdjacencyList.set(edge.market_b, reverseList);
        }
        reverseList.push(reverseNeighbor);
      }

      // Update state
      this.adjacencyList = newAdjacencyList;
      this.marketCount = newAdjacencyList.size;
      this.edgeCount = edges.length * 2; // Bidirectional
      this.lastRebuild = Date.now();

      // Sync to KV cache
      const cacheService = this.getCacheService();
      const { success, failed } = await cacheService.setNeighborsBatch(this.adjacencyList);
      await cacheService.setRebuildTimestamp(this.lastRebuild);

      console.log(
        `[GraphManager] Rebuild complete: ${this.marketCount} markets, ${this.edgeCount} edges. ` +
        `KV sync: ${success} success, ${failed} failed`
      );

      // Persist metadata
      await this.persistState();
    } finally {
      this.isRebuilding = false;
      // Release the lock
      await this.ctx.storage.delete("rebuild:lock");
    }
  }

  /**
   * Run the aggregation query to populate graph_edges from signals.
   *
   * NOTE: We insert ALL edges (no HAVING filter) so that decayed edges get
   * updated with their new low weights. The weight > 0.1 filter is applied
   * at query time in fetchEdgesFromClickHouse. This ensures stale high-weight
   * edges don't persist indefinitely in the ReplacingMergeTree.
   */
  private async runAggregationQuery(): Promise<void> {
    const query = `
      INSERT INTO trading_data.graph_edges
      SELECT
          market_a,
          market_b,
          edge_type,
          log(greatest(0.001, 1 + sum(
            strength *
            CASE signal_source
              WHEN 'trigger_fire' THEN 2.0
              WHEN 'user_trigger' THEN 1.5
              WHEN 'user_analysis' THEN 1.0
              WHEN 'trigger_miss' THEN 0.5
              WHEN 'cron_correlation' THEN 1.0
              WHEN 'metadata_tag' THEN 0.8
              WHEN 'bellman_ford_cycle' THEN 2.5
              ELSE 1.0
            END *
            exp(-dateDiff('day', created_at, now()) * 0.693147 / 30)
          ))) AS weight,
          uniqExactIf(user_id, user_id != '') AS user_count,
          count() AS signal_count,
          max(created_at) AS last_signal_at,
          now64(6) AS updated_at
      FROM trading_data.graph_edge_signals
      WHERE created_at > now() - INTERVAL 90 DAY
      GROUP BY market_a, market_b, edge_type
    `;

    try {
      const response = await fetch(this.env.CLICKHOUSE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
        body: query,
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("[GraphManager] Aggregation query failed:", text);
      }
    } catch (error) {
      console.error("[GraphManager] Error running aggregation query:", error);
      // Non-fatal - we'll still try to read existing edges
    }
  }

  /**
   * Fetch edges from ClickHouse graph_edges table.
   * Warns if edge count exceeds limit (100K) to help operators tune thresholds.
   */
  private async fetchEdgesFromClickHouse(): Promise<GraphEdge[]> {
    const MAX_EDGES = 100000;
    const MIN_WEIGHT_THRESHOLD = 0.1;

    // First, check total count to warn if truncation will occur
    try {
      const countQuery = `
        SELECT count() as edge_count
        FROM trading_data.graph_edges FINAL
        WHERE weight > ${MIN_WEIGHT_THRESHOLD}
        FORMAT JSONEachRow
      `;

      const countResponse = await fetch(this.env.CLICKHOUSE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
        body: countQuery,
      });

      if (countResponse.ok) {
        const countText = await countResponse.text();
        if (countText.trim()) {
          const { edge_count } = JSON.parse(countText.trim());
          if (edge_count > MAX_EDGES) {
            console.warn(
              `[GraphManager] Graph has ${edge_count} edges but only fetching top ${MAX_EDGES}. ` +
              `Consider increasing MIN_WEIGHT_THRESHOLD (currently ${MIN_WEIGHT_THRESHOLD}) or MAX_EDGES.`
            );
          }
        }
      }
    } catch (error) {
      // Non-fatal - continue with fetch
      console.warn("[GraphManager] Failed to check edge count:", error);
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
      WHERE weight > ${MIN_WEIGHT_THRESHOLD}
      ORDER BY weight DESC
      LIMIT ${MAX_EDGES}
      FORMAT JSONEachRow
    `;

    try {
      const response = await fetch(this.env.CLICKHOUSE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
        body: query,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`ClickHouse query failed: ${text}`);
      }

      const text = await response.text();
      if (!text.trim()) {
        return [];
      }

      const edges: GraphEdge[] = [];
      for (const line of text.trim().split("\n")) {
        if (line.trim()) {
          try {
            edges.push(JSON.parse(line) as GraphEdge);
          } catch (e) {
            console.warn("[GraphManager] Failed to parse edge:", line);
          }
        }
      }

      return edges;
    } catch (error) {
      console.error("[GraphManager] Error fetching edges:", error);
      return [];
    }
  }

  /**
   * Run Bellman-Ford negative cycle detection.
   */
  async runCycleDetection(): Promise<NegativeCycle[]> {
    console.log("[GraphManager] Running negative cycle detection");

    try {
      const cycles = detectNegativeCycles(this.adjacencyList);

      this.cachedCycles = cycles;
      this.lastCycleDetection = Date.now();

      // Store detected cycles in ClickHouse
      if (cycles.length > 0) {
        await this.storeCyclesToClickHouse(cycles);

        // Also emit to queue for alerting
        await this.emitCycleAlerts(cycles);
      }

      console.log(`[GraphManager] Cycle detection complete: ${cycles.length} cycles found`);

      // Persist state
      await this.persistState();

      return cycles;
    } catch (error) {
      console.error("[GraphManager] Cycle detection error:", error);
      return [];
    }
  }

  /**
   * Store detected cycles to ClickHouse.
   */
  private async storeCyclesToClickHouse(cycles: NegativeCycle[]): Promise<void> {
    if (cycles.length === 0) return;

    const rows = cycles.map(c => {
      // detected_at is in milliseconds (standard JS timestamp)
      const date = new Date(c.detected_at);
      return JSON.stringify({
        cycle_id: c.cycle_id,
        markets: c.markets,
        total_weight: c.total_weight,
        opportunity_type: c.opportunity_type,
        detected_at: date.toISOString().replace("T", " ").replace("Z", ""),
        detected_date: date.toISOString().split("T")[0],
        metadata: "{}",
      });
    }).join("\n");

    try {
      const response = await fetch(
        `${this.env.CLICKHOUSE_URL}?query=${encodeURIComponent("INSERT INTO trading_data.graph_negative_cycles FORMAT JSONEachRow")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
            "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
          },
          body: rows,
        }
      );

      if (!response.ok) {
        const text = await response.text();
        console.error("[GraphManager] Failed to store cycles:", text);
      }
    } catch (error) {
      console.error("[GraphManager] Error storing cycles:", error);
    }
  }

  /**
   * Emit cycle alerts to queue.
   */
  private async emitCycleAlerts(cycles: NegativeCycle[]): Promise<void> {
    for (const cycle of cycles) {
      try {
        await this.env.GRAPH_QUEUE.send({
          type: "negative_cycle_detected",
          cycle: cycle.markets,
          weight: cycle.total_weight,
          opportunity_type: cycle.opportunity_type,
        });
      } catch (error) {
        console.error("[GraphManager] Error emitting cycle alert:", error);
      }
    }
  }

  /**
   * Persist state to DO storage.
   */
  private async persistState(): Promise<void> {
    const state: StoredGraphState = {
      lastRebuild: this.lastRebuild,
      edgeCount: this.edgeCount,
      marketCount: this.marketCount,
      lastCycleDetection: this.lastCycleDetection,
      cachedCycles: this.cachedCycles,
    };

    await this.ctx.storage.put("graphState", state);
  }

  // ============================================================
  // Public methods for internal use
  // ============================================================

  /**
   * Get neighbors for a market (for direct DO-to-DO calls).
   */
  getNeighbors(marketId: string): GraphNeighbor[] {
    return this.adjacencyList.get(marketId) || [];
  }

  /**
   * Get the full adjacency list (for internal use).
   */
  getFullGraph(): Map<string, GraphNeighbor[]> {
    return this.adjacencyList;
  }
}
