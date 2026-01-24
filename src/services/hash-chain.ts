import type { GapBackfillJob, HashChainState } from "../types/orderbook";

/**
 * Hash Chain Validator
 *
 * Tracks orderbook hash sequence to detect gaps.
 * Uses dedicated KV namespace to avoid conflicts with MARKET_CACHE.
 *
 * IMPORTANT: This validator is for gap detection and duplicate suppression,
 * NOT for data integrity. Failures should never block data insertion.
 */
export class HashChainValidator {
  private readonly KV_TIMEOUT_MS = 2000; // 2 second timeout for KV operations

  constructor(
    private cache: KVNamespace,
    private gapQueue: Queue<GapBackfillJob>
  ) {}

  /**
   * Wrap a promise with a timeout to prevent hanging on slow KV operations
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutId = setTimeout(() => {
        console.warn(`[HashChain] KV operation timed out after ${timeoutMs}ms, using fallback`);
        resolve(fallback);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Validate incoming book event against known hash chain
   * Returns detailed validation result for monitoring and gap detection
   */
  async validateAndUpdate(
    assetId: string,
    newHash: string,
    sourceTs: number,
    marketSource?: string,
    marketType?: string
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

    // Use timeout wrapper to prevent hanging on slow KV operations
    const lastState = await this.withTimeout(
      this.cache.get<HashChainState>(cacheKey, "json"),
      this.KV_TIMEOUT_MS,
      null // Treat timeout as "first event" - safe fallback
    );

    // First event for this asset
    if (!lastState) {
      // Fire-and-forget KV update - don't block on put failures
      this.cache.put(
        cacheKey,
        JSON.stringify({
          hash: newHash,
          timestamp: sourceTs,
          sequence: 1,
        } satisfies HashChainState),
        { expirationTtl: 86400 }
      ).catch((err) => console.error(`[HashChain] KV put failed for ${assetId}:`, err));

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
    // Increased from 5s to 30s to tolerate normal reconnection delays (typically 5-15s)
    // This reduces false positive gap events while still catching real data gaps
    // (exchange issues typically last minutes, not seconds)
    const MAX_EXPECTED_GAP_MS = 30000; // 30 seconds

    let gapDetected = false;
    if (timeDelta > MAX_EXPECTED_GAP_MS) {
      console.warn(
        `[HashChain] Gap detected for ${assetId}: ${timeDelta}ms ` +
        `(${lastState.hash.slice(0, 8)}... -> ${newHash.slice(0, 8)}...)`
      );
      gapDetected = true;

      // Fire-and-forget queue job - gap detection is best-effort
      this.gapQueue.send({
        market_source: marketSource || "polymarket",
        market_type: marketType,
        asset_id: assetId,
        last_known_hash: lastState.hash,
        gap_detected_at: Date.now(),
        retry_count: 0,
      }).catch((err) => console.error(`[HashChain] Failed to queue gap backfill for ${assetId}:`, err));
    }

    const newSequence = lastState.sequence + 1;

    // Fire-and-forget KV update - don't block on put failures
    this.cache.put(
      cacheKey,
      JSON.stringify({
        hash: newHash,
        timestamp: sourceTs,
        sequence: newSequence,
      } satisfies HashChainState),
      { expirationTtl: 86400 }
    ).catch((err) => console.error(`[HashChain] KV put failed for ${assetId}:`, err));

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
}
