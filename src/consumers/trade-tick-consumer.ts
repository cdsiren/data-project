// src/consumers/trade-tick-consumer.ts
// Processes trade ticks for execution-level data (critical for backtesting)

import type { Env } from "../types";
import type { TradeTick } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { DB_CONFIG } from "../config/database";

export async function tradeTickConsumer(
  batch: MessageBatch<TradeTick>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) {
    return;
  }

  const rows = batch.messages.map((m) => {
    const t = m.body;
    return {
      asset_id: t.asset_id,
      condition_id: t.condition_id,
      trade_id: t.trade_id,
      price: t.price,
      size: t.size,
      side: t.side,
      source_ts: toClickHouseDateTime64(t.source_ts),
      ingestion_ts: toClickHouseDateTime64Micro(t.ingestion_ts),
    };
  });

  const body = rows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      `${env.CLICKHOUSE_URL}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.trade_ticks FORMAT JSONEachRow`,
      {
        method: "POST",
        headers: {
          "X-ClickHouse-User": env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
          "Content-Type": "text/plain",
        },
        body,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClickHouse insert failed: ${error}`);
    }

    // Ack all messages on success
    for (const message of batch.messages) {
      message.ack();
    }

    console.log(`[TradeTick] Inserted ${batch.messages.length} trades`);
  } catch (error) {
    console.error("[TradeTick] ClickHouse insert failed:", error);

    // Retry all messages on failure
    for (const message of batch.messages) {
      message.retry();
    }
  }
}
