import type { Env } from "../types";
import type { EnhancedOrderbookSnapshot } from "../types/orderbook";
import { toClickHouseDateTime64, toClickHouseDateTime64Micro } from "../utils/datetime";
import { DB_CONFIG } from "../config/database";

/**
 * ClickHouse client for orderbook-specific operations
 *
 * Uses your existing CLICKHOUSE_URL and CLICKHOUSE_TOKEN secrets.
 * Only interacts with ob_* tables to avoid conflicts.
 */
export class ClickHouseOrderbookClient {
  private baseUrl: string;
  private headers: HeadersInit;

  constructor(env: Env) {
    this.baseUrl = env.CLICKHOUSE_URL;
    this.headers = {
      "X-ClickHouse-User": env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
      "Content-Type": "text/plain",
    };
  }

  /**
   * Insert orderbook snapshots (batch)
   */
  async insertSnapshots(snapshots: EnhancedOrderbookSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;

    const rows = snapshots.map((s) => ({
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
      is_resync: s.is_resync ? 1 : 0,
      sequence_number: s.sequence_number,
    }));

    const body = rows.map((r) => JSON.stringify(r)).join("\n");

    const response = await fetch(
      `${this.baseUrl}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.ob_snapshots FORMAT JSONEachRow`,
      { method: "POST", headers: this.headers, body }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClickHouse insert failed: ${error}`);
    }
  }

  /**
   * Record latency metric
   */
  async recordLatency(
    assetId: string,
    sourceTs: number,
    ingestionTs: number,
    eventType: string
  ): Promise<void> {
    const row = {
      asset_id: assetId,
      source_ts: toClickHouseDateTime64(sourceTs),
      ingestion_ts: toClickHouseDateTime64Micro(ingestionTs),
      event_type: eventType,
    };

    await fetch(
      `${this.baseUrl}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.ob_latency FORMAT JSONEachRow`,
      { method: "POST", headers: this.headers, body: JSON.stringify(row) }
    );
  }

  /**
   * Record gap event
   */
  async recordGapEvent(
    assetId: string,
    lastKnownHash: string,
    newHash: string,
    gapDurationMs: number
  ): Promise<void> {
    const row = {
      asset_id: assetId,
      detected_at: toClickHouseDateTime64(Date.now()),
      last_known_hash: lastKnownHash,
      new_hash: newHash,
      gap_duration_ms: gapDurationMs,
      resolution: "PENDING",
    };

    await fetch(
      `${this.baseUrl}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.ob_gap_events FORMAT JSONEachRow`,
      { method: "POST", headers: this.headers, body: JSON.stringify(row) }
    );
  }

}
