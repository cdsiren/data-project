// src/consumers/full-l2-snapshot-consumer.ts
// Inserts periodic full L2 orderbook snapshots (every 5 minutes)

import type { Env } from "../types";
import type { FullL2Snapshot } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName } from "../config/database";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "../services/clickhouse-client";

export async function fullL2SnapshotConsumer(
  batch: MessageBatch<FullL2Snapshot>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  const rows = batch.messages.map((m) => {
    const s = m.body;
    return {
      asset_id: s.asset_id,
      condition_id: s.condition_id,
      source_ts: toClickHouseDateTime64(s.source_ts),
      ingestion_ts: toClickHouseDateTime64Micro(s.ingestion_ts),
      book_hash: s.book_hash,
      bid_prices: s.bids.map((b) => b.price),
      bid_sizes: s.bids.map((b) => b.size),
      ask_prices: s.asks.map((a) => a.price),
      ask_sizes: s.asks.map((a) => a.size),
      tick_size: s.tick_size,
      is_resync: 0, // Periodic snapshots are not resyncs
      sequence_number: s.sequence_number,
      neg_risk: s.neg_risk ? 1 : 0,
      order_min_size: s.order_min_size ?? 0,
    };
  });

  const body = rows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      buildAsyncInsertUrl(env.CLICKHOUSE_URL, getFullTableName("OB_SNAPSHOTS")),
      {
        method: "POST",
        headers: buildClickHouseHeaders(env.CLICKHOUSE_USER, env.CLICKHOUSE_TOKEN),
        body,
      }
    );

    if (!response.ok) {
      throw new Error(`ClickHouse insert failed: ${await response.text()}`);
    }

    for (const msg of batch.messages) msg.ack();
    console.log(`[FullL2] Inserted ${batch.messages.length} full L2 snapshots`);
  } catch (error) {
    console.error("[FullL2] Insert failed:", error);
    for (const msg of batch.messages) msg.retry();
  }
}
