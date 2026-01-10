// src/consumers/snapshot-consumer.ts
// Enhanced with hash chain validation for gap detection - critical for reliable historical data

import type { Env } from "../types";
import type { EnhancedOrderbookSnapshot } from "../types/orderbook";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import { HashChainValidator } from "../services/hash-chain";

interface ValidationStats {
  total: number;
  valid: number;
  duplicates: number;
  gaps: number;
  first: number;
  resyncs: number;
}

export async function snapshotConsumer(
  batch: MessageBatch<EnhancedOrderbookSnapshot>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);
  const hashChain = new HashChainValidator(env.HASH_CHAIN_CACHE, env.GAP_BACKFILL_QUEUE);

  const validSnapshots: EnhancedOrderbookSnapshot[] = [];
  const stats: ValidationStats = {
    total: batch.messages.length,
    valid: 0,
    duplicates: 0,
    gaps: 0,
    first: 0,
    resyncs: 0,
  };

  // Process each snapshot with hash chain validation
  for (const message of batch.messages) {
    const snapshot = message.body;

    // Resync snapshots (from gap backfill) bypass hash chain validation
    // but still get inserted to fill the gap
    if (snapshot.is_resync) {
      stats.resyncs++;
      validSnapshots.push(snapshot);
      message.ack();
      continue;
    }

    try {
      // Validate against hash chain
      const validation = await hashChain.validateAndUpdate(
        snapshot.asset_id,
        snapshot.book_hash,
        snapshot.source_ts
      );

      if (validation.isDuplicate) {
        // Skip duplicate - already processed
        stats.duplicates++;
        message.ack();
        continue;
      }

      if (validation.gapDetected) {
        stats.gaps++;
        // Gap backfill job already queued by validator
        // Record gap event for monitoring with full context
        await clickhouse.recordGapEvent(
          snapshot.asset_id,
          validation.previousHash || "UNKNOWN",
          snapshot.book_hash,
          validation.gapDurationMs || 0
        ).catch((err) => console.error("[Snapshot] Failed to record gap event:", err));

        console.warn(
          `[Snapshot] GAP DETECTED: ${snapshot.asset_id} ` +
          `gap=${validation.gapDurationMs}ms seq=${validation.sequence}`
        );
      }

      if (validation.isFirst) {
        stats.first++;
      }

      // Valid snapshot - add to batch
      stats.valid++;
      validSnapshots.push(snapshot);
      message.ack();
    } catch (error) {
      console.error(`[Snapshot] Validation error for ${snapshot.asset_id}:`, error);
      // On validation error, still insert but don't update hash chain
      validSnapshots.push(snapshot);
      message.ack();
    }
  }

  // Batch insert valid snapshots to ClickHouse
  if (validSnapshots.length > 0) {
    try {
      await clickhouse.insertSnapshots(validSnapshots);
      console.log(
        `[Snapshot] Inserted ${validSnapshots.length}/${stats.total} ` +
        `(valid=${stats.valid}, dup=${stats.duplicates}, gaps=${stats.gaps}, ` +
        `first=${stats.first}, resync=${stats.resyncs})`
      );
    } catch (error) {
      console.error("[Snapshot] ClickHouse insert failed:", error);
      // Don't retry acked messages - they'll be lost
      // This is a trade-off: we prioritize not double-processing over guaranteed delivery
      // The gap detection will catch any missing data
    }
  } else if (stats.duplicates > 0) {
    console.log(`[Snapshot] Skipped ${stats.duplicates} duplicates`);
  }
}
