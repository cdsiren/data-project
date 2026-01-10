import type { Env } from "../types";
import type { EnhancedOrderbookSnapshot } from "../types/orderbook";

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
      source_ts: new Date(s.source_ts)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
      ingestion_ts: new Date(s.ingestion_ts / 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
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
      `${this.baseUrl}/?query=INSERT INTO polymarket.ob_snapshots FORMAT JSONEachRow`,
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
      source_ts: new Date(sourceTs)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
      ingestion_ts: new Date(ingestionTs / 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
      event_type: eventType,
    };

    await fetch(
      `${this.baseUrl}/?query=INSERT INTO polymarket.ob_latency FORMAT JSONEachRow`,
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
      detected_at: new Date().toISOString().replace("T", " ").slice(0, -1),
      last_known_hash: lastKnownHash,
      new_hash: newHash,
      gap_duration_ms: gapDurationMs,
      resolution: "PENDING",
    };

    await fetch(
      `${this.baseUrl}/?query=INSERT INTO polymarket.ob_gap_events FORMAT JSONEachRow`,
      { method: "POST", headers: this.headers, body: JSON.stringify(row) }
    );
  }

  /**
   * Get snapshot at specific time (for pre-trade analysis)
   */
  async getSnapshotAt(
    assetId: string,
    beforeTs: Date
  ): Promise<EnhancedOrderbookSnapshot | null> {
    const ts = beforeTs.toISOString().replace("T", " ").slice(0, -1);

    const response = await fetch(
      `${this.baseUrl}/?query=${encodeURIComponent(`
        SELECT *
        FROM polymarket.ob_snapshots
        WHERE asset_id = '${assetId}' AND source_ts <= '${ts}'
        ORDER BY source_ts DESC
        LIMIT 1
        FORMAT JSONEachRow
      `)}`,
      { method: "GET", headers: this.headers }
    );

    if (!response.ok) return null;

    const text = await response.text();
    if (!text.trim()) return null;

    const row = JSON.parse(text);
    return this.rowToSnapshot(row);
  }

  private rowToSnapshot(row: Record<string, unknown>): EnhancedOrderbookSnapshot {
    const bidPrices = row.bid_prices as number[];
    const bidSizes = row.bid_sizes as number[];
    const askPrices = row.ask_prices as number[];
    const askSizes = row.ask_sizes as number[];

    return {
      asset_id: row.asset_id as string,
      token_id: row.asset_id as string,
      condition_id: row.condition_id as string,
      source_ts: new Date(row.source_ts as string).getTime(),
      ingestion_ts: new Date(row.ingestion_ts as string).getTime() * 1000,
      book_hash: row.book_hash as string,
      bids: bidPrices.map((p: number, i: number) => ({
        price: p,
        size: bidSizes[i],
      })),
      asks: askPrices.map((p: number, i: number) => ({
        price: p,
        size: askSizes[i],
      })),
      best_bid: row.best_bid as number,
      best_ask: row.best_ask as number,
      mid_price: row.mid_price as number,
      spread: row.spread as number,
      spread_bps: row.spread_bps as number,
      tick_size: row.tick_size as number,
      is_resync: (row.is_resync as number) === 1,
      sequence_number: row.sequence_number as number,
    };
  }
}
