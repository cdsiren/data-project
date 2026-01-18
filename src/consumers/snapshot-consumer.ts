// src/consumers/snapshot-consumer.ts
// Writes BBO snapshots directly to ClickHouse with hash chain validation
// Aggregation is handled by ClickHouse materialized views (more efficient)

import type { Env } from "../types";
import type { BBOSnapshot } from "../types/orderbook";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import { HashChainValidator } from "../services/hash-chain";

interface ValidationStats {
  total: number;
  valid: number;
  duplicates: number;
  gaps: number;
  first: number;
  resyncs: number;
  validation_errors: number;
}

export async function snapshotConsumer(
  batch: MessageBatch<BBOSnapshot>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);
  const hashChain = new HashChainValidator(env.HASH_CHAIN_CACHE, env.GAP_BACKFILL_QUEUE);

  const validSnapshots: BBOSnapshot[] = [];
  const stats: ValidationStats = {
    total: batch.messages.length,
    valid: 0,
    duplicates: 0,
    gaps: 0,
    first: 0,
    resyncs: 0,
    validation_errors: 0,
  };

  // Process each snapshot with hash chain validation
  for (const message of batch.messages) {
    const snapshot = message.body;

    // Resync snapshots (from gap backfill) bypass hash chain validation
    if (snapshot.is_resync) {
      stats.resyncs++;
      validSnapshots.push(snapshot);
      message.ack();
      continue;
    }

    try {
      const validation = await hashChain.validateAndUpdate(
        snapshot.asset_id,
        snapshot.book_hash,
        snapshot.source_ts
      );

      if (validation.isDuplicate) {
        stats.duplicates++;
        message.ack();
        continue;
      }

      if (validation.gapDetected) {
        stats.gaps++;
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

      stats.valid++;
      validSnapshots.push(snapshot);
      message.ack();
    } catch (error) {
      // Validation errors are likely permanent (bad data format), so ack to avoid infinite retries
      // but do NOT push to validSnapshots - this prevents bad data from entering the system
      console.error(`[Snapshot] Validation error for ${snapshot.asset_id}:`, error);
      stats.validation_errors++;
      message.ack();
    }
  }

  if (validSnapshots.length === 0) {
    if (stats.duplicates > 0) {
      console.log(`[Snapshot] Skipped ${stats.duplicates} duplicates`);
    }
    return;
  }

  // Insert directly to ClickHouse (aggregation handled by materialized views)
  try {
    await clickhouse.insertSnapshots(validSnapshots);
    console.log(
      `[Snapshot] Inserted ${validSnapshots.length}/${stats.total} BBO snapshots ` +
      `(valid=${stats.valid}, dup=${stats.duplicates}, gaps=${stats.gaps}, ` +
      `first=${stats.first}, resync=${stats.resyncs})`
    );

    // Record latency metrics in BATCH (single HTTP request instead of N)
    const latencyMetrics = validSnapshots.map((snapshot) => ({
      assetId: snapshot.asset_id,
      sourceTs: snapshot.source_ts,
      ingestionTs: snapshot.ingestion_ts,
      eventType: snapshot.is_resync ? "resync" : "bbo",
    }));

    clickhouse.recordLatencyBatch(latencyMetrics)
      .catch((err) => console.error("[Snapshot] Latency recording failed:", err));
  } catch (error) {
    console.error("[Snapshot] ClickHouse insert failed:", error);
  }
}
