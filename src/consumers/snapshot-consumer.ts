// src/consumers/snapshot-consumer.ts
// BBO snapshots with hash chain validation for gap detection

import type { Env } from "../types";
import type { BBOSnapshot } from "../types/orderbook";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import { HashChainValidator } from "../services/hash-chain";

export async function snapshotConsumer(
  batch: MessageBatch<BBOSnapshot>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);
  const hashChain = new HashChainValidator(env.HASH_CHAIN_CACHE, env.GAP_BACKFILL_QUEUE);

  const validSnapshots: BBOSnapshot[] = [];
  const validMessages: Message<BBOSnapshot>[] = [];
  let duplicates = 0, gaps = 0, resyncs = 0;

  for (const message of batch.messages) {
    const snapshot = message.body;

    // Resyncs bypass hash chain validation
    if (snapshot.is_resync) {
      resyncs++;
      validSnapshots.push(snapshot);
      validMessages.push(message);
      continue;
    }

    try {
      const v = await hashChain.validateAndUpdate(snapshot.asset_id, snapshot.book_hash, snapshot.source_ts);

      if (v.isDuplicate) {
        duplicates++;
        message.ack();
        continue;
      }

      if (v.gapDetected) {
        gaps++;
        clickhouse.recordGapEvent(snapshot.asset_id, v.previousHash || "UNKNOWN", snapshot.book_hash, v.gapDurationMs || 0)
          .catch(e => console.error("[Snapshot] Gap event failed:", e));
      }

      validSnapshots.push(snapshot);
      validMessages.push(message);
    } catch {
      // Hash chain errors shouldn't block data - insert anyway
      validSnapshots.push(snapshot);
      validMessages.push(message);
    }
  }

  if (validSnapshots.length === 0) {
    if (duplicates > 0) console.log(`[Snapshot] Skipped ${duplicates} duplicates`);
    return;
  }

  try {
    await clickhouse.insertSnapshots(validSnapshots);
    for (const msg of validMessages) msg.ack();
    console.log(`[Snapshot] Inserted ${validSnapshots.length}/${batch.messages.length} (dup=${duplicates}, gaps=${gaps}, resync=${resyncs})`);
  } catch (error) {
    console.error("[Snapshot] Insert failed, retrying:", error);
    for (const msg of validMessages) msg.retry();
  }
}
