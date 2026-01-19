// src/consumers/level-change-consumer.ts
import type { Env } from "../types";
import type { OrderbookLevelChange } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName } from "../config/database";
import { insertRows, handleBatchResult } from "../services/clickhouse-utils";

export async function levelChangeConsumer(
  batch: MessageBatch<OrderbookLevelChange>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  const rows = batch.messages.map(m => ({
    asset_id: m.body.asset_id,
    condition_id: m.body.condition_id,
    source_ts: toClickHouseDateTime64(m.body.source_ts),
    ingestion_ts: toClickHouseDateTime64Micro(m.body.ingestion_ts),
    side: m.body.side,
    price: m.body.price,
    old_size: m.body.old_size,
    new_size: m.body.new_size,
    size_delta: m.body.size_delta,
    change_type: m.body.change_type,
    book_hash: m.body.book_hash,
    sequence_number: m.body.sequence_number,
  }));

  const result = await insertRows(env, getFullTableName("OB_LEVEL_CHANGES"), rows);
  handleBatchResult(batch.messages, result, "LevelChange");

  if (result.success) {
    console.log(`[LevelChange] Inserted ${rows.length} level changes`);
  }
}
