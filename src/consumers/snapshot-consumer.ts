// src/consumers/snapshot-consumer.ts
// Enhanced with hash chain validation and optional aggregation routing

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
  validation_errors: number;
}

export async function snapshotConsumer(
  batch: MessageBatch<EnhancedOrderbookSnapshot>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);
  const hashChain = new HashChainValidator(env.HASH_CHAIN_CACHE, env.GAP_BACKFILL_QUEUE);
  const useAggregation = env.AGGREGATE_SNAPSHOTS === "true";

  const validSnapshots: EnhancedOrderbookSnapshot[] = [];
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

  // Route to aggregator or direct insert based on config
  if (useAggregation) {
    await routeToAggregator(validSnapshots, env, stats);
  } else {
    await insertDirectToClickHouse(validSnapshots, clickhouse, stats);
  }
}

async function routeToAggregator(
  snapshots: EnhancedOrderbookSnapshot[],
  env: Env,
  stats: ValidationStats
): Promise<void> {
  // Group snapshots by asset for routing to per-asset aggregator DOs
  const snapshotsByAsset = new Map<string, EnhancedOrderbookSnapshot[]>();

  for (const snapshot of snapshots) {
    const assetId = snapshot.asset_id;
    const existing = snapshotsByAsset.get(assetId) || [];
    existing.push(snapshot);
    snapshotsByAsset.set(assetId, existing);
  }

  const errors: string[] = [];

  for (const [assetId, assetSnapshots] of snapshotsByAsset) {
    try {
      const id = env.SNAPSHOT_AGGREGATOR.idFromName(assetId);
      const stub = env.SNAPSHOT_AGGREGATOR.get(id);

      const response = await stub.fetch(new Request("http://internal/ingest", {
        method: "POST",
        body: JSON.stringify(assetSnapshots),
        headers: { "Content-Type": "application/json" },
      }));

      if (!response.ok) {
        errors.push(`${assetId}: ${await response.text()}`);
      }
    } catch (error) {
      errors.push(`${assetId}: ${String(error)}`);
    }
  }

  if (errors.length > 0) {
    console.error(`[Snapshot] Aggregator routing errors: ${errors.join(", ")}`);
  }

  console.log(
    `[Snapshot] Routed ${snapshots.length}/${stats.total} to aggregator ` +
    `(${snapshotsByAsset.size} assets, dup=${stats.duplicates}, gaps=${stats.gaps})`
  );
}

async function insertDirectToClickHouse(
  snapshots: EnhancedOrderbookSnapshot[],
  clickhouse: ClickHouseOrderbookClient,
  stats: ValidationStats
): Promise<void> {
  try {
    await clickhouse.insertSnapshots(snapshots);
    console.log(
      `[Snapshot] Inserted ${snapshots.length}/${stats.total} ` +
      `(valid=${stats.valid}, dup=${stats.duplicates}, gaps=${stats.gaps}, ` +
      `first=${stats.first}, resync=${stats.resyncs})`
    );

    // Record latency metrics (fire-and-forget)
    Promise.all(
      snapshots.map((snapshot) =>
        clickhouse.recordLatency(
          snapshot.asset_id,
          snapshot.source_ts,
          snapshot.ingestion_ts,
          snapshot.is_resync ? "resync" : "snapshot"
        )
      )
    ).catch((err) => console.error("[Snapshot] Latency recording failed:", err));
  } catch (error) {
    console.error("[Snapshot] ClickHouse insert failed:", error);
  }
}
