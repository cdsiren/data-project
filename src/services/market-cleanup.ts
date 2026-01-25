// src/services/market-cleanup.ts
// Coordinated market cleanup service to prevent race conditions
// between scheduled handler and gap-backfill consumer

import type { Env } from "../types";

/**
 * Cleanup state stored in KV for idempotency
 */
interface CleanupState {
  cleaned_at: number;
  cleaned_by: "scheduled" | "gap_backfill";
}

/**
 * Service for coordinating market cleanup operations.
 *
 * PROBLEM: Race condition between scheduled handler and gap-backfill consumer:
 * 1. Gap backfill gets 404 -> deletes hash chain
 * 2. Scheduled handler also tries to delete same keys
 * 3. Between deletion and unsubscribe, stale BBO could arrive and recreate hash chain
 *
 * SOLUTION:
 * - Check idempotency key BEFORE cleanup
 * - Unsubscribe FIRST (stops new data)
 * - Then delete hash chain (prevents recreation)
 * - Mark as cleaned (prevents duplicate work)
 */
export class MarketCleanupService {
  private static readonly CLEANUP_TTL_SECONDS = 86400; // 24 hours

  constructor(
    private env: Env,
    private getShardForMarket: (conditionId: string) => string
  ) {}

  /**
   * Check if a market/asset has already been cleaned up.
   * Used for idempotency to prevent duplicate cleanup work.
   */
  async isAlreadyCleaned(assetId: string): Promise<boolean> {
    const cleanupKey = `cleanup:${assetId}`;
    const existing = await this.env.MARKET_CACHE.get(cleanupKey);
    return existing !== null;
  }

  /**
   * Mark an asset as cleaned up with TTL for idempotency.
   */
  private async markAsCleaned(
    assetId: string,
    cleanedBy: "scheduled" | "gap_backfill"
  ): Promise<void> {
    const cleanupKey = `cleanup:${assetId}`;
    const state: CleanupState = {
      cleaned_at: Date.now(),
      cleaned_by: cleanedBy,
    };
    await this.env.MARKET_CACHE.put(cleanupKey, JSON.stringify(state), {
      expirationTtl: MarketCleanupService.CLEANUP_TTL_SECONDS,
    });
  }

  /**
   * Clean up a single asset (typically called from gap-backfill on 404).
   *
   * Order of operations:
   * 1. Check idempotency (skip if already cleaned)
   * 2. Delete hash chain cache
   * 3. Mark as cleaned
   *
   * Note: Does NOT unsubscribe because we may not know the condition_id
   * in the gap-backfill consumer. The scheduled handler handles unsubscribe.
   */
  async cleanupAsset(assetId: string): Promise<{ skipped: boolean }> {
    // Step 1: Check idempotency
    if (await this.isAlreadyCleaned(assetId)) {
      console.log(`[Cleanup] Asset ${assetId.slice(0, 20)}... already cleaned, skipping`);
      return { skipped: true };
    }

    // Step 2: Delete hash chain cache
    try {
      await this.env.HASH_CHAIN_CACHE.delete(`chain:${assetId}`);
    } catch (err) {
      console.error(`[Cleanup] Failed to delete hash chain for ${assetId.slice(0, 20)}...:`, err);
      // Continue anyway - marking as cleaned prevents retry loops
    }

    // Step 3: Mark as cleaned
    await this.markAsCleaned(assetId, "gap_backfill");
    console.log(`[Cleanup] Cleaned asset ${assetId.slice(0, 20)}... (gap_backfill)`);

    return { skipped: false };
  }

  /**
   * Full market cleanup (called from scheduled handler).
   *
   * Order of operations (CRITICAL - order matters!):
   * 1. Check idempotency for ALL tokens
   * 2. Unsubscribe FIRST (stops new data from creating hash chain entries)
   * 3. Delete hash chain cache for all tokens
   * 4. Mark all tokens as cleaned
   */
  async cleanupMarket(
    conditionId: string,
    tokenIds: string[]
  ): Promise<{ unsubscribed: number; cleaned: number; skipped: number }> {
    let unsubscribed = 0;
    let cleaned = 0;
    let skipped = 0;

    // Step 1: Filter out already-cleaned tokens
    const tokensToClean: string[] = [];
    for (const tokenId of tokenIds) {
      if (await this.isAlreadyCleaned(tokenId)) {
        skipped++;
      } else {
        tokensToClean.push(tokenId);
      }
    }

    if (tokensToClean.length === 0) {
      console.log(`[Cleanup] Market ${conditionId.slice(0, 20)}... all ${skipped} tokens already cleaned`);
      return { unsubscribed: 0, cleaned: 0, skipped };
    }

    // Step 2: Unsubscribe FIRST (prevents new hash chain entries)
    const shardId = this.getShardForMarket(conditionId);
    const doId = this.env.ORDERBOOK_MANAGER.idFromName(shardId);
    const stub = this.env.ORDERBOOK_MANAGER.get(doId);

    try {
      await stub.fetch(new Request("https://do/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ token_ids: tokensToClean }),
      }));
      unsubscribed = tokensToClean.length;
      console.log(`[Cleanup] Unsubscribed ${unsubscribed} tokens for market ${conditionId.slice(0, 20)}...`);
    } catch (err) {
      console.error(`[Cleanup] Failed to unsubscribe market ${conditionId.slice(0, 20)}...:`, err);
      // Continue with hash chain cleanup anyway
    }

    // Step 3: Delete hash chain cache (parallel for efficiency)
    const deletePromises = tokensToClean.map(async (tokenId) => {
      try {
        await this.env.HASH_CHAIN_CACHE.delete(`chain:${tokenId}`);
        return true;
      } catch (err) {
        console.error(`[Cleanup] Failed to delete hash chain for ${tokenId.slice(0, 20)}...:`, err);
        return false;
      }
    });
    const deleteResults = await Promise.all(deletePromises);
    cleaned = deleteResults.filter(Boolean).length;

    // Step 4: Mark all as cleaned (even if delete failed, to prevent retry loops)
    const markPromises = tokensToClean.map((tokenId) =>
      this.markAsCleaned(tokenId, "scheduled").catch((err) =>
        console.error(`[Cleanup] Failed to mark ${tokenId.slice(0, 20)}... as cleaned:`, err)
      )
    );
    await Promise.all(markPromises);

    console.log(
      `[Cleanup] Market ${conditionId.slice(0, 20)}... complete: ` +
      `unsubscribed=${unsubscribed}, cleaned=${cleaned}, skipped=${skipped}`
    );

    return { unsubscribed, cleaned, skipped };
  }
}
