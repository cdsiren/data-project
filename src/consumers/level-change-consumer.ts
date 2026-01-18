// src/consumers/level-change-consumer.ts
// Tracks order book level changes (placements, cancellations, updates)

import type { Env } from "../types";
import type { OrderbookLevelChange } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName } from "../config/database";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "../services/clickhouse-client";

export async function levelChangeConsumer(
  batch: MessageBatch<OrderbookLevelChange>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  const rows = batch.messages.map((m) => {
    const c = m.body;
    return {
      asset_id: c.asset_id,
      condition_id: c.condition_id,
      source_ts: toClickHouseDateTime64(c.source_ts),
      ingestion_ts: toClickHouseDateTime64Micro(c.ingestion_ts),
      side: c.side,
      price: c.price,
      old_size: c.old_size,
      new_size: c.new_size,
      size_delta: c.size_delta,
      change_type: c.change_type,
      book_hash: c.book_hash,
      sequence_number: c.sequence_number,
    };
  });

  const body = rows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      buildAsyncInsertUrl(env.CLICKHOUSE_URL, getFullTableName("OB_LEVEL_CHANGES")),
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
    console.log(`[LevelChange] Inserted ${batch.messages.length} level changes`);
  } catch (error) {
    console.error("[LevelChange] Insert failed:", error);
    for (const msg of batch.messages) msg.retry();
  }
}
