import type { Env } from "../types";
import type { BBOSnapshot } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName, getDefaultMarketSource, getDefaultMarketType, getMarketType } from "../config/database";
import type { MarketSource } from "../core/enums";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "./clickhouse-client";

/** Valid market sources - must match MarketSource type in core/enums.ts */
const VALID_MARKET_SOURCES = new Set(["polymarket", "kalshi", "uniswap", "binance"]);

/**
 * Validate and normalize market_source to prevent data corruption.
 * Returns default if invalid to ensure data is never lost.
 */
function validateMarketSource(value: string | undefined): string {
  if (!value || !VALID_MARKET_SOURCES.has(value)) {
    if (value) {
      console.warn(`[ClickHouse] Invalid market_source "${value}", using default`);
    }
    return getDefaultMarketSource();
  }
  return value;
}

/**
 * ClickHouse client for orderbook-specific operations
 *
 * Uses async inserts for efficient batching without Buffer tables.
 * Async inserts buffer data server-side, reducing CPU from merge operations.
 */
export class ClickHouseOrderbookClient {
  private baseUrl: string;
  private headers: HeadersInit;

  constructor(env: Env) {
    this.baseUrl = env.CLICKHOUSE_URL;
    this.headers = buildClickHouseHeaders(env.CLICKHOUSE_USER, env.CLICKHOUSE_TOKEN);
  }

  /**
   * Insert BBO (best bid/offer) snapshots in batch
   * Optimized: stores only top-of-book instead of full L2 depth (~20-50x less data)
   */
  async insertSnapshots(snapshots: BBOSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;

    const rows = snapshots.map((s) => {
      const marketSource = validateMarketSource(s.market_source);
      const marketType = s.market_type ?? getMarketType(marketSource as MarketSource);
      return {
        market_source: marketSource,
        market_type: marketType,
        asset_id: s.asset_id,
        condition_id: s.condition_id,
        source_ts: toClickHouseDateTime64(s.source_ts),
        ingestion_ts: toClickHouseDateTime64Micro(s.ingestion_ts),
        book_hash: s.book_hash,
        best_bid: Number(s.best_bid ?? 0),
        best_ask: Number(s.best_ask ?? 0),
        bid_size: Number(s.bid_size ?? 0),
        ask_size: Number(s.ask_size ?? 0),
        mid_price: Number(s.mid_price ?? 0),
        spread_bps: Number(s.spread_bps ?? 0),
        tick_size: Number(s.tick_size),
        is_resync: s.is_resync ? 1 : 0,
        sequence_number: Number(s.sequence_number ?? 0),
        neg_risk: s.neg_risk ? 1 : 0,
        order_min_size: Number(s.order_min_size ?? 0),
      };
    });

    const body = rows.map((r) => JSON.stringify(r)).join("\n");

    const response = await fetch(
      buildAsyncInsertUrl(this.baseUrl, getFullTableName("OB_BBO")),
      { method: "POST", headers: this.headers, body }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClickHouse insert failed: ${error}`);
    }
  }

  /**
   * Record latency metrics in batch (single HTTP request instead of N requests)
   * ~50-100x reduction in HTTP overhead
   */
  async recordLatencyBatch(
    metrics: Array<{
      assetId: string;
      sourceTs: number;
      ingestionTs: number;
      eventType: string;
      marketSource?: string;
      marketType?: string;
    }>
  ): Promise<void> {
    if (metrics.length === 0) return;

    const rows = metrics.map((m) => {
      const marketSource = validateMarketSource(m.marketSource);
      const marketType = m.marketType ?? getMarketType(marketSource as MarketSource);
      return {
        market_source: marketSource,
        market_type: marketType,
        asset_id: m.assetId,
        source_ts: toClickHouseDateTime64(m.sourceTs),
        ingestion_ts: toClickHouseDateTime64Micro(m.ingestionTs),
        event_type: m.eventType,
      };
    });

    const body = rows.map((r) => JSON.stringify(r)).join("\n");

    await fetch(
      buildAsyncInsertUrl(this.baseUrl, getFullTableName("OB_LATENCY")),
      { method: "POST", headers: this.headers, body }
    );
  }

  /**
   * Record gap event
   */
  async recordGapEvent(
    assetId: string,
    lastKnownHash: string,
    newHash: string,
    gapDurationMs: number,
    marketSource?: string,
    marketType?: string
  ): Promise<void> {
    const effectiveMarketSource = validateMarketSource(marketSource);
    const effectiveMarketType = marketType ?? getMarketType(effectiveMarketSource as MarketSource);
    const row = {
      market_source: effectiveMarketSource,
      market_type: effectiveMarketType,
      asset_id: assetId,
      detected_at: toClickHouseDateTime64(Date.now()),
      last_known_hash: lastKnownHash,
      new_hash: newHash,
      gap_duration_ms: gapDurationMs,
      resolution: "PENDING",
    };

    await fetch(
      buildAsyncInsertUrl(this.baseUrl, getFullTableName("OB_GAP_EVENTS")),
      { method: "POST", headers: this.headers, body: JSON.stringify(row) }
    );
  }
}
