// src/consumers/realtime-tick-consumer.ts
// Inserts realtime trigger ticks into ClickHouse (24h TTL for alerts/monitoring)
// HFT-grade: Decimal128 prices, tick direction, crossed detection

import type { Env } from "../types";
import type { RealtimeTick, TickDirection } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName } from "../config/database";

/**
 * Converts a number to a string suitable for ClickHouse Decimal128
 */
function toDecimalString(value: number | null): string {
  if (value === null || value === undefined) return "0";
  return value.toFixed(18);
}

/**
 * Maps TickDirection to ClickHouse Enum8 value
 */
function tickDirectionToEnum(direction: TickDirection): string {
  switch (direction) {
    case "UP":
      return "UP";
    case "DOWN":
      return "DOWN";
    case "UNCHANGED":
    default:
      return "UNCHANGED";
  }
}

export async function realtimeTickConsumer(
  batch: MessageBatch<RealtimeTick>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  const rows = batch.messages.map((m) => {
    const t = m.body;
    return {
      asset_id: t.asset_id,
      source_ts: toClickHouseDateTime64(t.source_ts),
      // Decimal128 for exact price precision
      best_bid: toDecimalString(t.best_bid),
      best_ask: toDecimalString(t.best_ask),
      mid_price: toDecimalString(t.mid_price),
      spread_bps: t.spread_bps ?? 0,
      // HFT microstructure fields
      tick_direction: tickDirectionToEnum(t.tick_direction),
      crossed: t.crossed ? 1 : 0,
      book_hash: t.book_hash,
      sequence_number: t.sequence_number,
      ingestion_ts: toClickHouseDateTime64Micro(t.ingestion_ts),
    };
  });

  const body = rows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      `${env.CLICKHOUSE_URL}/?query=INSERT INTO ${getFullTableName("OB_TICKS_REALTIME")} FORMAT JSONEachRow`,
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
      throw new Error(`ClickHouse insert failed: ${await response.text()}`);
    }

    for (const msg of batch.messages) msg.ack();
    console.log(`[RTTick] Inserted ${batch.messages.length} realtime ticks (HFT-grade)`);
  } catch (error) {
    console.error("[RTTick] Insert failed:", error);
    for (const msg of batch.messages) msg.retry();
  }
}
