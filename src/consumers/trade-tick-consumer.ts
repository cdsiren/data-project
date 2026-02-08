// src/consumers/trade-tick-consumer.ts
import type { Env } from "../types";
import type { TradeTick } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName, getBatchMarketDefaults, normalizeMarketInfo } from "../config/database";
import { insertRows, handleBatchResult } from "../services/clickhouse-utils";

export async function tradeTickConsumer(
  batch: MessageBatch<TradeTick>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) return;

  // OPTIMIZATION: Pre-compute defaults once per batch instead of per-message
  const defaults = getBatchMarketDefaults();

  const rows = batch.messages.map(m => {
    // Use pre-computed defaults when no override provided
    const { source, type } = m.body.market_source
      ? normalizeMarketInfo(m.body.market_source, m.body.market_type)
      : defaults;

    return {
      market_source: source,
      market_type: type,
      asset_id: m.body.asset_id,
      condition_id: m.body.condition_id,
      trade_id: m.body.trade_id,
      price: m.body.price,
      size: m.body.size,
      side: m.body.side,
      source_ts: toClickHouseDateTime64(m.body.source_ts),
      ingestion_ts: toClickHouseDateTime64Micro(m.body.ingestion_ts),
    };
  });

  const result = await insertRows(env, getFullTableName("TRADE_TICKS"), rows);
  handleBatchResult(batch.messages, result, "TradeTick");

  if (result.success) {
    console.log(`[TradeTick] Inserted ${rows.length} trades`);
  }
}
