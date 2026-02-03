// Shard derivation utilities - mirrors backend sharding logic

import { SYSTEM_CONFIG } from "./constants";

const SHARD_COUNT = SYSTEM_CONFIG.SHARD_COUNT;

/**
 * Modified DJB2 hash function - must be IDENTICAL to backend (src/index.ts)
 *
 * NOTE: This is a MODIFIED DJB2 that adds the character index to the hash.
 * Standard DJB2: hash = hash * 33 + char
 * This version:  hash = hash * 31 + char + index
 *
 * The index addition improves distribution for strings with repeated characters
 * (common in hex IDs like condition_id). The multiplier is 31 ((x << 5) - x).
 *
 * DO NOT change this formula without updating backend (src/index.ts) in sync,
 * or all shard assignments will be incorrect causing data routing failures.
 */
function djb2Hash(str: string): number {
  return Array.from(str).reduce(
    (acc, char, idx) => ((acc << 5) - acc) + char.charCodeAt(0) + idx,
    0
  );
}

/**
 * Get the shard name for a given condition ID
 * This must match the backend's sharding algorithm exactly
 */
export function getShardForCondition(conditionId: string): string {
  const hash = djb2Hash(conditionId);
  const shardIndex = Math.abs(hash) % SHARD_COUNT;
  return `shard-${shardIndex}`;
}

/**
 * Extract shard index from shard name
 */
export function getShardIndex(shardName: string): number {
  const match = shardName.match(/^shard-(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}

/**
 * Total number of shards in the system
 */
export { SHARD_COUNT };
