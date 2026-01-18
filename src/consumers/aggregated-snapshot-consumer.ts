// src/consumers/aggregated-snapshot-consumer.ts
// Inserts aggregated 1-minute OHLC bars into ClickHouse
// HFT-grade: Decimal128 prices, microsecond timestamps, true VWAP

import type { Env } from "../types";
import type { AggregatedSnapshot } from "../types/orderbook";
import { toClickHouseDateTime, toClickHouseDateTime64 } from "../utils/datetime";
import { getFullTableName } from "../config/database";

/**
 * Converts a number to a string suitable for ClickHouse Decimal128
 * Preserves full precision without scientific notation
 */
function toDecimalString(value: number | null): string {
  if (value === null || value === undefined) return "0";
  // Use toFixed with high precision to avoid scientific notation
  // and preserve decimal places for Decimal128(18)
  return value.toFixed(18);
}

export async function aggregatedSnapshotConsumer(
  batch: MessageBatch<AggregatedSnapshot[]>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  // Flatten batched arrays (each message may contain multiple bars)
  const rows: AggregatedSnapshot[] = [];
  for (const msg of batch.messages) {
    if (Array.isArray(msg.body)) {
      rows.push(...msg.body);
    } else {
      rows.push(msg.body as unknown as AggregatedSnapshot);
    }
  }

  if (rows.length === 0) {
    for (const msg of batch.messages) msg.ack();
    return;
  }

  // Map to ClickHouse row format with HFT-grade fields
  const clickhouseRows = rows.map((r) => ({
    asset_id: r.asset_id,
    condition_id: r.condition_id,
    minute: toClickHouseDateTime(r.minute),

    // OHLC bid (Decimal128 as string for precision)
    open_bid: toDecimalString(r.open_bid),
    high_bid: toDecimalString(r.high_bid),
    low_bid: toDecimalString(r.low_bid),
    close_bid: toDecimalString(r.close_bid),

    // OHLC ask (Decimal128 as string for precision)
    open_ask: toDecimalString(r.open_ask),
    high_ask: toDecimalString(r.high_ask),
    low_ask: toDecimalString(r.low_ask),
    close_ask: toDecimalString(r.close_ask),

    // True VWAP (Decimal128 as string for precision)
    vwap_mid: toDecimalString(r.vwap_mid),

    // Depth metrics
    avg_spread_bps: r.avg_spread_bps,
    avg_bid_depth: Math.round(r.avg_bid_depth), // UInt64
    avg_ask_depth: Math.round(r.avg_ask_depth), // UInt64
    avg_bid_depth_5: Math.round(r.avg_bid_depth_5), // UInt64
    avg_ask_depth_5: Math.round(r.avg_ask_depth_5), // UInt64
    avg_imbalance: r.avg_imbalance,

    // Volume totals for VWAP verification
    total_bid_volume: Math.round(r.total_bid_volume), // UInt64
    total_ask_volume: Math.round(r.total_ask_volume), // UInt64

    tick_count: r.tick_count,

    // Microsecond timestamps (DateTime64(6))
    first_source_ts: toClickHouseDateTime64(r.first_source_ts),
    last_source_ts: toClickHouseDateTime64(r.last_source_ts),

    // Hash chain
    first_hash: r.first_hash,
    last_hash: r.last_hash,

    // Sequence tracking
    sequence_start: r.sequence_start,
    sequence_end: r.sequence_end,
  }));

  const body = clickhouseRows.map((r) => JSON.stringify(r)).join("\n");

  try {
    const response = await fetch(
      `${env.CLICKHOUSE_URL}/?query=INSERT INTO ${getFullTableName("OB_SNAPSHOTS_1M_BUFFER")} FORMAT JSONEachRow`,
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
    console.log(`[AggSnap] Inserted ${rows.length} 1-min bars (HFT-grade)`);
  } catch (error) {
    console.error("[AggSnap] Insert failed:", error);
    for (const msg of batch.messages) msg.retry();
  }
}
