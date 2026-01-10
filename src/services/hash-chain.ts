import type { GapBackfillJob, HashChainState } from "../types/orderbook";

/**
 * Hash Chain Validator
 *
 * Tracks orderbook hash sequence to detect gaps.
 * Uses dedicated KV namespace to avoid conflicts with MARKET_CACHE.
 */
export class HashChainValidator {
  constructor(
    private cache: KVNamespace,
    private gapQueue: Queue<GapBackfillJob>
  ) {}

  /**
   * Validate incoming book event against known hash chain
   * Returns detailed validation result for monitoring and gap detection
   */
  async validateAndUpdate(
    assetId: string,
    newHash: string,
    sourceTs: number
  ): Promise<{
    valid: boolean;
    isDuplicate: boolean;
    gapDetected: boolean;
    isFirst: boolean;
    previousHash: string | null;
    previousTimestamp: number | null;
    gapDurationMs: number | null;
    sequence: number;
  }> {
    const cacheKey = `chain:${assetId}`;

    const lastState = await this.cache.get<HashChainState>(cacheKey, "json");

    // First event for this asset
    if (!lastState) {
      await this.cache.put(
        cacheKey,
        JSON.stringify({
          hash: newHash,
          timestamp: sourceTs,
          sequence: 1,
        } satisfies HashChainState),
        { expirationTtl: 86400 }
      );

      return {
        valid: true,
        isDuplicate: false,
        gapDetected: false,
        isFirst: true,
        previousHash: null,
        previousTimestamp: null,
        gapDurationMs: null,
        sequence: 1,
      };
    }

    // Duplicate hash = duplicate event
    if (lastState.hash === newHash) {
      return {
        valid: false,
        isDuplicate: true,
        gapDetected: false,
        isFirst: false,
        previousHash: lastState.hash,
        previousTimestamp: lastState.timestamp,
        gapDurationMs: null,
        sequence: lastState.sequence,
      };
    }

    // Check for suspicious time gap (potential missed messages)
    const timeDelta = sourceTs - lastState.timestamp;
    const MAX_EXPECTED_GAP_MS = 5000; // 5 seconds

    let gapDetected = false;
    if (timeDelta > MAX_EXPECTED_GAP_MS) {
      console.warn(
        `[HashChain] Gap detected for ${assetId}: ${timeDelta}ms ` +
        `(${lastState.hash.slice(0, 8)}... -> ${newHash.slice(0, 8)}...)`
      );
      gapDetected = true;

      // Queue backfill job
      await this.gapQueue.send({
        asset_id: assetId,
        last_known_hash: lastState.hash,
        gap_detected_at: Date.now(),
        retry_count: 0,
      });
    }

    const newSequence = lastState.sequence + 1;

    // Update state
    await this.cache.put(
      cacheKey,
      JSON.stringify({
        hash: newHash,
        timestamp: sourceTs,
        sequence: newSequence,
      } satisfies HashChainState),
      { expirationTtl: 86400 }
    );

    return {
      valid: true,
      isDuplicate: false,
      gapDetected,
      isFirst: false,
      previousHash: lastState.hash,
      previousTimestamp: lastState.timestamp,
      gapDurationMs: gapDetected ? timeDelta : null,
      sequence: newSequence,
    };
  }

  /**
   * Reset hash chain (e.g., after reconnection)
   */
  async reset(assetId: string): Promise<void> {
    await this.cache.delete(`chain:${assetId}`);
  }

  /**
   * Get current sequence number
   */
  async getSequence(assetId: string): Promise<number> {
    const state = await this.cache.get<HashChainState>(
      `chain:${assetId}`,
      "json"
    );
    return state?.sequence ?? 0;
  }
}
