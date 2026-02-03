import type { Env } from "../types";
import type { BBOSnapshot } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { getFullTableName, normalizeMarketInfo, getBatchMarketDefaults } from "../config/database";
import { buildAsyncInsertUrl, buildClickHouseHeaders } from "./clickhouse-client";
import { executeInsert, type InsertResult } from "./clickhouse-utils";

/** Gap event row for batched insert */
interface GapEventRow {
  market_source: string;
  market_type: string;
  asset_id: string;
  detected_at: string;
  last_known_hash: string;
  new_hash: string;
  gap_duration_ms: number;
  resolution: string;
}

/**
 * ClickHouse client for orderbook-specific operations
 */
export class ClickHouseOrderbookClient {
  private baseUrl: string;
  private headers: HeadersInit;

  // Gap event buffering (flushes on size or timeout)
  private static gapEventBuffer: GapEventRow[] = [];
  private static gapEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(env: Env) {
    this.baseUrl = env.CLICKHOUSE_URL;
    this.headers = buildClickHouseHeaders(env.CLICKHOUSE_USER, env.CLICKHOUSE_TOKEN);
  }

  /**
   * Insert BBO snapshots in batch.
   */
  async insertSnapshots(snapshots: BBOSnapshot[]): Promise<InsertResult> {
    if (snapshots.length === 0) return { success: true, shouldRetry: false };

    const defaults = getBatchMarketDefaults();
    const rows = snapshots.map((s) => {
      const { source, type } = s.market_source
        ? normalizeMarketInfo(s.market_source, s.market_type)
        : defaults;

      return {
        market_source: source,
        market_type: type,
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
    return executeInsert(
      buildAsyncInsertUrl(this.baseUrl, getFullTableName("OB_BBO")),
      this.headers,
      body
    );
  }

  /**
   * Record latency metrics in batch (fire-and-forget)
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

    const defaults = getBatchMarketDefaults();
    const rows = metrics.map((m) => {
      const { source, type } = m.marketSource
        ? normalizeMarketInfo(m.marketSource, m.marketType)
        : defaults;

      return {
        market_source: source,
        market_type: type,
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
   * Record gap event with buffering (flushes on size 100 or timeout 5s)
   */
  async recordGapEvent(
    assetId: string,
    lastKnownHash: string,
    newHash: string,
    gapDurationMs: number,
    marketSource?: string,
    marketType?: string
  ): Promise<void> {
    const { source, type } = normalizeMarketInfo(marketSource, marketType);
    ClickHouseOrderbookClient.gapEventBuffer.push({
      market_source: source,
      market_type: type,
      asset_id: assetId,
      detected_at: toClickHouseDateTime64(Date.now()),
      last_known_hash: lastKnownHash,
      new_hash: newHash,
      gap_duration_ms: gapDurationMs,
      resolution: "PENDING",
    });

    // Schedule flush timer if not already set
    if (!ClickHouseOrderbookClient.gapEventFlushTimer) {
      ClickHouseOrderbookClient.gapEventFlushTimer = setTimeout(() => {
        this.flushGapEvents();
      }, 5000);
    }

    // Flush immediately if buffer is full
    if (ClickHouseOrderbookClient.gapEventBuffer.length >= 100) {
      await this.flushGapEvents();
    }
  }

  /**
   * Flush buffered gap events to ClickHouse
   */
  private async flushGapEvents(): Promise<void> {
    if (ClickHouseOrderbookClient.gapEventFlushTimer) {
      clearTimeout(ClickHouseOrderbookClient.gapEventFlushTimer);
      ClickHouseOrderbookClient.gapEventFlushTimer = null;
    }

    const buffer = ClickHouseOrderbookClient.gapEventBuffer;
    if (buffer.length === 0) return;
    ClickHouseOrderbookClient.gapEventBuffer = [];

    try {
      const body = buffer.map((r) => JSON.stringify(r)).join("\n");
      const response = await fetch(
        buildAsyncInsertUrl(this.baseUrl, getFullTableName("OB_GAP_EVENTS")),
        { method: "POST", headers: this.headers, body }
      );

      if (!response.ok) {
        console.error(`[ClickHouse] Gap event insert failed: ${await response.text()}`);
      }
    } catch (e) {
      console.error("[ClickHouse] Gap event flush failed:", e);
    }
  }
}
