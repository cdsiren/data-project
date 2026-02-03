// src/consumers/snapshot-consumer.ts
// BBO snapshots with hash chain validation for gap detection

import type { Env } from "../types";
import type { BBOSnapshot } from "../types/orderbook";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import { HashChainValidator } from "../services/hash-chain";
import { handleBatchResult } from "../services/clickhouse-utils";

export async function snapshotConsumer(
  batch: MessageBatch<BBOSnapshot>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);
  const hashChain = new HashChainValidator(env.HASH_CHAIN_CACHE, env.GAP_BACKFILL_QUEUE);

  const validSnapshots: BBOSnapshot[] = [];
  const validMessages: Message<BBOSnapshot>[] = [];
  let duplicates = 0, gaps = 0;

  for (const message of batch.messages) {
    const snapshot = message.body;

    // Resyncs bypass hash chain validation
    if (snapshot.is_resync) {
      validSnapshots.push(snapshot);
      validMessages.push(message);
      continue;
    }

    try {
      const v = await hashChain.validateAndUpdate(
        snapshot.asset_id,
        snapshot.book_hash,
        snapshot.source_ts,
        snapshot.market_source,
        snapshot.market_type
      );

      if (v.isDuplicate) {
        duplicates++;
        message.ack();
        continue;
      }

      if (v.gapDetected) {
        gaps++;
        clickhouse.recordGapEvent(
          snapshot.asset_id,
          v.previousHash || "UNKNOWN",
          snapshot.book_hash,
          v.gapDurationMs || 0,
          snapshot.market_source,
          snapshot.market_type
        ).catch(() => {});
      }

      validSnapshots.push(snapshot);
      validMessages.push(message);
    } catch {
      validSnapshots.push(snapshot);
      validMessages.push(message);
    }
  }

  if (validSnapshots.length === 0) return;

  const result = await clickhouse.insertSnapshots(validSnapshots);
  handleBatchResult(validMessages, result, "Snapshot");

  // Sample latency metrics at 0.1%
  if (result.success && Math.random() < 0.001 && validSnapshots.length > 0) {
    const s = validSnapshots[0];
    clickhouse.recordLatencyBatch([{
      assetId: s.asset_id,
      sourceTs: s.source_ts,
      ingestionTs: s.ingestion_ts,
      eventType: "bbo_snapshot",
      marketSource: s.market_source,
      marketType: s.market_type,
    }]).catch(() => {});
  }
}
