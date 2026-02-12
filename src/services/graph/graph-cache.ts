// src/services/graph/graph-cache.ts
// KV cache wrapper for graph adjacency lists

import type { GraphNeighbor, AdjacencyList, NeighborSortOptions } from "./types";

/**
 * KV namespace key prefixes for graph data.
 */
const CACHE_KEYS = {
  NEIGHBORS: "graph:neighbors:",
  EDGES_BATCH: "graph:edges:batch:",
  REBUILD_TIMESTAMP: "graph:rebuild:timestamp",
  STATS: "graph:stats",
} as const;

/**
 * Default TTL for graph cache entries (15 minutes).
 * Matches the graph rebuild cron interval.
 */
const DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * GraphCacheService provides a KV-backed cache for graph adjacency lists.
 * Designed for the Tier 2 (KV Cache) layer of the graph architecture.
 *
 * Key features:
 * - 15-minute TTL matching graph rebuild cycle
 * - Batch operations for efficient cache warming
 * - Sorted neighbor retrieval with filtering
 */
export class GraphCacheService {
  constructor(
    private readonly kv: KVNamespace,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  // ============================================================
  // Single Market Operations
  // ============================================================

  /**
   * Get neighbors for a single market from KV cache.
   *
   * @param marketId - Market ID (condition_id)
   * @returns Cached adjacency list or null if not found/expired
   */
  async getNeighbors(marketId: string): Promise<GraphNeighbor[] | null> {
    const key = CACHE_KEYS.NEIGHBORS + marketId;
    const cached = await this.kv.get<AdjacencyList>(key, "json");

    if (!cached) return null;

    // Check if data is too stale (beyond 2x TTL is definitely stale)
    const staleCutoff = Date.now() - this.ttlSeconds * 2 * 1000;
    if (cached.updated_at < staleCutoff) {
      return null;
    }

    return cached.neighbors;
  }

  /**
   * Set neighbors for a single market in KV cache.
   *
   * @param marketId - Market ID (condition_id)
   * @param neighbors - Array of neighbor entries
   */
  async setNeighbors(marketId: string, neighbors: GraphNeighbor[]): Promise<void> {
    const key = CACHE_KEYS.NEIGHBORS + marketId;
    const value: AdjacencyList = {
      market_id: marketId,
      neighbors,
      updated_at: Date.now(),
    };

    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: this.ttlSeconds,
    });
  }

  /**
   * Get neighbors sorted by weight and user count.
   *
   * @param marketId - Market ID (condition_id)
   * @param options - Sorting and filtering options
   * @returns Sorted and filtered neighbors
   */
  async getNeighborsSorted(
    marketId: string,
    options: NeighborSortOptions = {}
  ): Promise<GraphNeighbor[]> {
    const { minWeight = 0, minUserCount = 0, limit = 10, edgeTypes } = options;

    const neighbors = await this.getNeighbors(marketId);
    if (!neighbors) return [];

    return neighbors
      .filter(n => {
        if (Math.abs(n.weight) < minWeight) return false;
        if (n.user_count < minUserCount) return false;
        if (edgeTypes && !edgeTypes.includes(n.edge_type)) return false;
        return true;
      })
      .sort((a, b) => {
        // Primary sort: user_count DESC (more users = more confidence)
        if (b.user_count !== a.user_count) {
          return b.user_count - a.user_count;
        }
        // Secondary sort: weight DESC (stronger relationship)
        return Math.abs(b.weight) - Math.abs(a.weight);
      })
      .slice(0, limit);
  }

  // ============================================================
  // Batch Operations
  // ============================================================

  /**
   * Set neighbors for multiple markets in parallel.
   * Used during graph rebuild to warm the cache efficiently.
   *
   * @param adjacencyList - Map of market_id -> neighbors
   */
  async setNeighborsBatch(
    adjacencyList: Map<string, GraphNeighbor[]>
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    // Process in batches to avoid overwhelming KV
    const batchSize = 50;
    const entries = Array.from(adjacencyList.entries());

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async ([marketId, neighbors]) => {
          try {
            await this.setNeighbors(marketId, neighbors);
            success++;
          } catch (error) {
            console.error(`Failed to cache neighbors for ${marketId}:`, error);
            failed++;
          }
        })
      );
    }

    return { success, failed };
  }

  /**
   * Get neighbors for multiple markets in parallel.
   *
   * @param marketIds - Array of market IDs
   * @returns Map of market_id -> neighbors (only includes found entries)
   */
  async getNeighborsBatch(
    marketIds: string[]
  ): Promise<Map<string, GraphNeighbor[]>> {
    const results = new Map<string, GraphNeighbor[]>();

    // Process in batches
    const batchSize = 50;

    for (let i = 0; i < marketIds.length; i += batchSize) {
      const batch = marketIds.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async marketId => {
          const neighbors = await this.getNeighbors(marketId);
          return { marketId, neighbors };
        })
      );

      for (const { marketId, neighbors } of batchResults) {
        if (neighbors) {
          results.set(marketId, neighbors);
        }
      }
    }

    return results;
  }

  // ============================================================
  // Cache Management
  // ============================================================

  /**
   * Record the timestamp of the last graph rebuild.
   */
  async setRebuildTimestamp(timestamp: number = Date.now()): Promise<void> {
    await this.kv.put(CACHE_KEYS.REBUILD_TIMESTAMP, timestamp.toString(), {
      expirationTtl: this.ttlSeconds * 2, // Keep longer than data TTL
    });
  }

  /**
   * Get the timestamp of the last graph rebuild.
   */
  async getRebuildTimestamp(): Promise<number | null> {
    const value = await this.kv.get(CACHE_KEYS.REBUILD_TIMESTAMP);
    return value ? parseInt(value, 10) : null;
  }

  /**
   * Check if the cache needs to be rebuilt.
   */
  async needsRebuild(): Promise<boolean> {
    const lastRebuild = await this.getRebuildTimestamp();
    if (!lastRebuild) return true;

    const timeSinceRebuild = Date.now() - lastRebuild;
    return timeSinceRebuild > this.ttlSeconds * 1000;
  }

  /**
   * Store graph statistics.
   */
  async setStats(stats: Record<string, number | string>): Promise<void> {
    await this.kv.put(CACHE_KEYS.STATS, JSON.stringify(stats), {
      expirationTtl: this.ttlSeconds,
    });
  }

  /**
   * Get graph statistics.
   */
  async getStats(): Promise<Record<string, number | string> | null> {
    return this.kv.get(CACHE_KEYS.STATS, "json");
  }

  /**
   * Delete cached neighbors for a market.
   * Used when a market is resolved or removed.
   */
  async deleteNeighbors(marketId: string): Promise<void> {
    const key = CACHE_KEYS.NEIGHBORS + marketId;
    await this.kv.delete(key);
  }

  /**
   * List all cached market keys (for debugging/admin).
   * Note: KV list is eventually consistent and may not include recent writes.
   */
  async listCachedMarkets(limit: number = 100): Promise<string[]> {
    const list = await this.kv.list({
      prefix: CACHE_KEYS.NEIGHBORS,
      limit,
    });

    return list.keys.map(k => k.name.replace(CACHE_KEYS.NEIGHBORS, ""));
  }
}

// ============================================================
// Cross-Shard KV Service
// ============================================================

/**
 * Cross-shard coordination key prefixes.
 */
const CROSS_SHARD_KEYS = {
  TRIGGER_STATE: "xshard:trigger:",
} as const;

/**
 * Cross-shard trigger notification stored in KV.
 */
interface CrossShardNotification {
  trigger_id: string;
  shard_id: string;
  condition_index: number;
  market_id: string;
  asset_id: string;
  fired: boolean;
  actual_value: number;
  timestamp: number;
  expires_at: number;
}

/**
 * CrossShardService provides KV-backed coordination for compound triggers
 * that span multiple OrderbookManager shards.
 */
export class CrossShardService {
  constructor(
    private readonly kv: KVNamespace,
    private readonly ttlSeconds: number = 60 // Short TTL for real-time coordination
  ) {}

  /**
   * Publish a condition fire/unfire from a shard.
   * Key includes condition_index to support multiple conditions per shard.
   */
  async publishConditionUpdate(notification: CrossShardNotification): Promise<void> {
    const key = `${CROSS_SHARD_KEYS.TRIGGER_STATE}${notification.trigger_id}:${notification.shard_id}:${notification.condition_index}`;
    await this.kv.put(key, JSON.stringify(notification), {
      expirationTtl: this.ttlSeconds,
    });
  }

  /**
   * Get all shard notifications for a trigger.
   */
  async getTriggerState(triggerId: string): Promise<CrossShardNotification[]> {
    const prefix = `${CROSS_SHARD_KEYS.TRIGGER_STATE}${triggerId}:`;
    const list = await this.kv.list({ prefix });

    const notifications: CrossShardNotification[] = [];

    await Promise.all(
      list.keys.map(async key => {
        const value = await this.kv.get<CrossShardNotification>(key.name, "json");
        if (value) {
          notifications.push(value);
        }
      })
    );

    return notifications;
  }

  /**
   * Clear state for a trigger (after it fires or is deleted).
   */
  async clearTriggerState(triggerId: string): Promise<void> {
    const prefix = `${CROSS_SHARD_KEYS.TRIGGER_STATE}${triggerId}:`;
    const list = await this.kv.list({ prefix });

    await Promise.all(
      list.keys.map(key => this.kv.delete(key.name))
    );
  }

  /**
   * Aggregate cross-shard results and determine if trigger should fire.
   */
  async shouldTriggerFire(
    triggerId: string,
    mode: "ALL_OF" | "ANY_OF" | "N_OF_M",
    threshold: number,
    totalConditions: number
  ): Promise<{ shouldFire: boolean; firedConditions: number[]; notifications: CrossShardNotification[] }> {
    const notifications = await this.getTriggerState(triggerId);

    const firedConditions: number[] = [];
    for (const n of notifications) {
      if (n.fired) {
        firedConditions.push(n.condition_index);
      }
    }

    let shouldFire = false;

    switch (mode) {
      case "ALL_OF":
        shouldFire = firedConditions.length === totalConditions;
        break;
      case "ANY_OF":
        shouldFire = firedConditions.length > 0;
        break;
      case "N_OF_M":
        shouldFire = firedConditions.length >= threshold;
        break;
    }

    return { shouldFire, firedConditions, notifications };
  }
}

// ============================================================
// Edge Formatting Helpers
// ============================================================

/**
 * Format an edge reason for display in suggestions.
 */
export function formatEdgeReason(neighbor: GraphNeighbor): string {
  const { edge_type, user_count, weight } = neighbor;

  switch (edge_type) {
    case "correlation":
      if (user_count > 0) {
        return `${user_count} user${user_count > 1 ? "s" : ""} linked these markets`;
      }
      // Weight is log-scaled, show as strength score not percentage
      return `Correlation strength: ${weight.toFixed(2)}`;

    case "hedge":
      if (user_count > 0) {
        return `${user_count} user${user_count > 1 ? "s" : ""} use this as a hedge`;
      }
      // Weight is log-scaled, show as strength score not percentage
      return `Hedge strength: ${Math.abs(weight).toFixed(2)}`;

    case "causal":
      return `Related by shared topics/tags`;

    case "arbitrage":
      return `Potential arbitrage opportunity detected`;

    default:
      return `Connected with weight ${weight.toFixed(2)}`;
  }
}

/**
 * Infer edge type from analysis/trigger template type.
 */
export function inferEdgeType(templateType: string): "correlation" | "hedge" | "causal" {
  const type = templateType.toLowerCase();

  if (type.includes("hedge") || type.includes("inverse")) {
    return "hedge";
  }

  if (type.includes("caus") || type.includes("depend") || type.includes("trigger")) {
    return "causal";
  }

  // Default to correlation for most user-created relationships
  return "correlation";
}

/**
 * Generate all pairs from an array of market IDs.
 * Used for creating edge signals between related markets.
 */
export function allPairs<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }

  return pairs;
}
