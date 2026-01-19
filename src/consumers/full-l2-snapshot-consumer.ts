// src/consumers/full-l2-snapshot-consumer.ts
import type { Env } from "../types";
import type { FullL2Snapshot } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName } from "../config/database";
import { insertRows, handleBatchResult } from "../services/clickhouse-utils";

export async function fullL2SnapshotConsumer(
  batch: MessageBatch<FullL2Snapshot>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  const rows = batch.messages.map(m => ({
    asset_id: m.body.asset_id,
    condition_id: m.body.condition_id,
    source_ts: toClickHouseDateTime64(m.body.source_ts),
    ingestion_ts: toClickHouseDateTime64Micro(m.body.ingestion_ts),
    book_hash: m.body.book_hash,
    bid_prices: m.body.bids.map(b => b.price),
    bid_sizes: m.body.bids.map(b => b.size),
    ask_prices: m.body.asks.map(a => a.price),
    ask_sizes: m.body.asks.map(a => a.size),
    tick_size: m.body.tick_size,
    is_resync: 0,
    sequence_number: m.body.sequence_number,
    neg_risk: m.body.neg_risk ? 1 : 0,
    order_min_size: m.body.order_min_size ?? 0,
  }));

  const result = await insertRows(env, getFullTableName("OB_SNAPSHOTS"), rows);
  handleBatchResult(batch.messages, result, "FullL2");

  if (result.success) {
    console.log(`[FullL2] Inserted ${rows.length} full L2 snapshots`);
  }
}
