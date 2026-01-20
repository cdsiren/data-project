// src/adapters/base/sharding-strategy.ts
// Sharding strategy interface for distributing instruments across Durable Object shards

import type { MarketSource } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";

/**
 * Shard assignment result
 */
export interface ShardAssignment {
  shardId: string;
  shardIndex: number;
  marketSource: MarketSource;
}

/**
 * Sharding strategy interface
 * Determines which Durable Object shard handles which instruments
 *
 * Different markets may need different strategies:
 * - Binary markets (Polymarket, Kalshi): Keep YES/NO on same shard for arbitrage
 * - AMM pools (Uniswap): Independent sharding
 * - CEX orderbooks: Independent sharding
 *
 * IMPORTANT: getShardAssignment is async to allow proper shard key lookups.
 * This ensures binary market YES/NO pairs always land on the same shard.
 */
export interface IShardingStrategy {
  /** Market this strategy is for */
  readonly marketSource: MarketSource;

  /**
   * Get shard ID for an instrument (async to allow KV lookups)
   * Must be deterministic (same instrument always maps to same shard)
   *
   * @param nativeId - Native instrument ID (token_id, ticker, etc.)
   * @param shardCount - Total number of shards available
   * @returns Shard assignment details
   */
  getShardAssignment(nativeId: string, shardCount: number): Promise<ShardAssignment>;

  /**
   * Get the shard key used for hashing
   * For binary markets, this should be the market ID (condition_id)
   * For independent instruments, this is the instrument ID itself
   *
   * @param nativeId - Native instrument ID
   * @returns Key to use for shard hash calculation
   */
  getShardKey(nativeId: string): Promise<string>;

  /**
   * Get related instruments that MUST be on same shard
   * E.g., for Polymarket: YES and NO tokens for same market
   * E.g., for Kalshi: all outcomes of same multi-outcome event
   *
   * @param nativeId - Native instrument ID
   * @returns Array of related native IDs (including the input)
   */
  getRelatedInstruments(nativeId: string): Promise<string[]>;

  /**
   * Get maximum instruments per shard (market-specific limit)
   * E.g., Polymarket: 450 (due to 500 WS limit minus buffer)
   */
  getMaxInstrumentsPerShard(): number;

  /**
   * Get the shard ID range for this market
   * Allows different markets to use different shard ranges
   * E.g., Polymarket: 0-24, Kalshi: 25-49
   *
   * @returns [startIndex, endIndex] inclusive
   */
  getShardRange(): [number, number];
}

/**
 * DJB2 hash function for consistent shard assignment
 * Same as used in current Polymarket implementation
 */
export function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Convert to unsigned
}

/**
 * Base class for sharding strategies with common functionality
 */
export abstract class BaseShardingStrategy implements IShardingStrategy {
  abstract readonly marketSource: MarketSource;

  protected shardRange: [number, number] = [0, 24]; // Default 25 shards
  protected maxInstrumentsPerShard = 450;

  /**
   * Get shard assignment using the proper async shard key lookup.
   * This ensures related instruments (e.g., YES/NO pairs) land on the same shard.
   */
  async getShardAssignment(nativeId: string, shardCount: number): Promise<ShardAssignment> {
    // Properly await the shard key lookup
    const shardKey = await this.getShardKey(nativeId);
    const hash = djb2Hash(shardKey);
    const shardIndex = Math.abs(hash) % shardCount;

    return {
      shardId: `shard-${this.marketSource}-${shardIndex}`,
      shardIndex,
      marketSource: this.marketSource,
    };
  }

  abstract getShardKey(nativeId: string): Promise<string>;
  abstract getRelatedInstruments(nativeId: string): Promise<string[]>;

  getMaxInstrumentsPerShard(): number {
    return this.maxInstrumentsPerShard;
  }

  getShardRange(): [number, number] {
    return this.shardRange;
  }

  /**
   * Set the shard range for this market
   */
  setShardRange(start: number, end: number): void {
    this.shardRange = [start, end];
  }

  /**
   * Set max instruments per shard
   */
  setMaxInstrumentsPerShard(max: number): void {
    this.maxInstrumentsPerShard = max;
  }
}

/**
 * Simple hash-based sharding (no related instruments)
 * Use for markets where each instrument is independent
 */
export class SimpleHashShardingStrategy extends BaseShardingStrategy {
  readonly marketSource: MarketSource;

  constructor(marketSource: MarketSource) {
    super();
    this.marketSource = marketSource;
  }

  async getShardKey(nativeId: string): Promise<string> {
    return nativeId;
  }

  async getRelatedInstruments(nativeId: string): Promise<string[]> {
    return [nativeId]; // No related instruments
  }
}
