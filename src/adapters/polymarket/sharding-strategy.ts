// src/adapters/polymarket/sharding-strategy.ts
// Binary market sharding strategy - keeps YES/NO pairs on same shard

import type { MarketSource } from "../../core/enums";
import {
  BaseShardingStrategy,
  djb2Hash,
  type ShardAssignment,
} from "../base/sharding-strategy";
import type { PolymarketCacheValue } from "./types";

/**
 * Binary market sharding strategy
 * Shards by condition_id to keep YES/NO token pairs on the same shard
 * This enables low-latency arbitrage detection between complementary tokens
 */
export class BinaryMarketShardingStrategy extends BaseShardingStrategy {
  readonly marketSource: MarketSource = "polymarket";

  private marketCache: KVNamespace | null = null;
  private conditionIdCache: Map<string, string> = new Map(); // token_id -> condition_id

  constructor(shardCount: number = 25, maxInstrumentsPerShard: number = 450) {
    super();
    this.setShardRange(0, shardCount - 1);
    this.setMaxInstrumentsPerShard(maxInstrumentsPerShard);
  }

  /**
   * Initialize with KV namespace for condition_id lookups
   */
  setMarketCache(kvNamespace: KVNamespace): void {
    this.marketCache = kvNamespace;
  }

  /**
   * Pre-populate condition_id cache for faster lookups
   */
  setConditionId(tokenId: string, conditionId: string): void {
    this.conditionIdCache.set(tokenId, conditionId);
  }

  /**
   * Get shard assignment for an instrument (async for proper KV lookups)
   * Shards by condition_id to keep YES/NO pairs together
   *
   * IMPORTANT: This is now async to ensure we always get the correct shard
   * by properly looking up the condition_id from KV if not in local cache.
   */
  async getShardAssignment(nativeId: string, shardCount: number): Promise<ShardAssignment> {
    // Use getShardKey which properly handles cache and KV lookups
    const shardKey = await this.getShardKey(nativeId);
    const hash = djb2Hash(shardKey);
    const shardIndex = Math.abs(hash) % shardCount;

    return {
      shardId: `shard-${shardIndex}`,
      shardIndex,
      marketSource: this.marketSource,
    };
  }

  /**
   * Get shard key (condition_id for binary markets)
   * This ensures YES and NO tokens for the same market go to the same shard
   */
  async getShardKey(nativeId: string): Promise<string> {
    // Check local cache first
    const cached = this.conditionIdCache.get(nativeId);
    if (cached) {
      return cached;
    }

    // Try KV cache
    if (this.marketCache) {
      try {
        const cacheKey = `market:${nativeId}`;
        const value = await this.marketCache.get(cacheKey, "json") as PolymarketCacheValue | null;
        if (value?.condition_id) {
          // Store in local cache for future lookups
          this.conditionIdCache.set(nativeId, value.condition_id);
          return value.condition_id;
        }
      } catch (error) {
        console.warn(`[BinaryMarketSharding] Error fetching condition_id for ${nativeId}:`, error);
      }
    }

    // Fallback to using token ID as shard key
    // This is suboptimal but ensures we can still route
    return nativeId;
  }

  /**
   * Get related instruments (YES/NO pair for same condition)
   * These must be on the same shard for arbitrage detection
   */
  async getRelatedInstruments(nativeId: string): Promise<string[]> {
    // For now, just return the input
    // In full implementation, would look up both tokens for the condition_id
    // The OrderbookManager already handles this via assetToMarket mapping

    // Try to find condition_id
    const conditionId = await this.getShardKey(nativeId);

    // Find all tokens with this condition_id in local cache
    const related: string[] = [nativeId];
    for (const [tokenId, cid] of this.conditionIdCache) {
      if (cid === conditionId && tokenId !== nativeId) {
        related.push(tokenId);
      }
    }

    return related;
  }
}

/**
 * Compute shard ID for a market (standalone function for use outside class)
 * This maintains compatibility with existing code in index.ts
 */
export function getShardForMarket(conditionId: string, shardCount: number = 25): string {
  const hash = djb2Hash(conditionId);
  return `shard-${Math.abs(hash) % shardCount}`;
}

/**
 * @deprecated Use getShardForMarket instead for market-based routing
 */
export function getShardForAsset(assetId: string, shardCount: number = 25): string {
  const hash = djb2Hash(assetId);
  return `shard-${Math.abs(hash) % shardCount}`;
}
