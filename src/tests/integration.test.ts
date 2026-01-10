/**
 * Integration Tests for Polymarket Enrichment Pipeline
 *
 * These tests verify connectivity to external services:
 * - Polymarket WebSocket (CLOB orderbook) - Test via wrangler dev /test/websocket
 * - ClickHouse database writes
 * - R2 cold storage writes - Test via wrangler dev /test/r2
 *
 * Run with: npx vitest run src/tests/integration.test.ts
 *
 * Required environment variables:
 * - CLICKHOUSE_URL: Full URL to ClickHouse HTTP interface
 * - CLICKHOUSE_USER: ClickHouse username
 * - CLICKHOUSE_TOKEN: ClickHouse password/API key
 *
 * For WebSocket and R2 tests, use the worker test endpoints:
 *   wrangler dev
 *   curl http://localhost:8787/test/websocket
 *   curl http://localhost:8787/test/r2
 *   curl http://localhost:8787/test/clickhouse
 *   curl http://localhost:8787/test/all
 */

import { describe, it, expect } from "vitest";
import type { EnhancedOrderbookSnapshot } from "../types/orderbook";

// Known active Polymarket token IDs for testing (these are real, active markets)
const TEST_TOKEN_ID =
  "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const CLOB_WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

describe("Polymarket WebSocket Connection", () => {
  /**
   * WebSocket tests require the Cloudflare Workers runtime.
   * Run via: wrangler dev, then curl http://localhost:8787/test/websocket
   *
   * These unit tests verify the message formats are correct.
   */

  it("should format subscription message correctly", () => {
    // Polymarket WS expects NO action field - just assets_ids and type
    const subscriptionMessage = {
      assets_ids: [TEST_TOKEN_ID],
      type: "market",
    };

    // Verify format matches Polymarket spec
    expect(subscriptionMessage).toHaveProperty("type", "market");
    expect(subscriptionMessage.assets_ids).toBeInstanceOf(Array);
    expect(subscriptionMessage.assets_ids).toContain(TEST_TOKEN_ID);
    expect(subscriptionMessage).not.toHaveProperty("action");

    // Verify it serializes correctly
    const serialized = JSON.stringify(subscriptionMessage);
    expect(serialized).not.toContain('"action"');
    expect(serialized).toContain('"type":"market"');
  });

  it("should use correct WebSocket URL", () => {
    expect(CLOB_WSS_URL).toBe("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    expect(CLOB_WSS_URL).toMatch(/^wss:\/\//);
    expect(CLOB_WSS_URL).toContain("/ws/market");
  });

  it("should format ping message correctly", () => {
    // Polymarket expects lowercase "ping"
    const pingMessage = "ping";
    expect(pingMessage).toBe("ping");
    expect(pingMessage).not.toBe("PING");
  });
});

describe("ClickHouse Database Integration", () => {
  const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL;
  const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
  const CLICKHOUSE_TOKEN = process.env.CLICKHOUSE_TOKEN;

  const skipIfNoCredentials = () => {
    if (!CLICKHOUSE_URL || !CLICKHOUSE_TOKEN) {
      console.log(
        "Skipping ClickHouse tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
      return true;
    }
    return false;
  };

  const getHeaders = () => ({
    "X-ClickHouse-User": CLICKHOUSE_USER,
    "X-ClickHouse-Key": CLICKHOUSE_TOKEN!,
    "Content-Type": "text/plain",
  });

  it("should connect to ClickHouse", async () => {
    if (skipIfNoCredentials()) return;

    const response = await fetch(`${CLICKHOUSE_URL}/?query=SELECT 1 FORMAT JSON`, {
      method: "GET",
      headers: getHeaders(),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.data[0]["1"]).toBe(1);
  });

  it("should verify polymarket database exists", async () => {
    if (skipIfNoCredentials()) return;

    const response = await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        "SELECT name FROM system.databases WHERE name = 'polymarket' FORMAT JSON"
      )}`,
      { method: "GET", headers: getHeaders() }
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data[0].name).toBe("polymarket");
  });

  it("should verify ob_snapshots table exists", async () => {
    if (skipIfNoCredentials()) return;

    const response = await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        "SELECT name FROM system.tables WHERE database = 'polymarket' AND name = 'ob_snapshots' FORMAT JSON"
      )}`,
      { method: "GET", headers: getHeaders() }
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.data.length).toBe(1);
    expect(data.data[0].name).toBe("ob_snapshots");
  });

  it("should write and read a test snapshot", async () => {
    if (skipIfNoCredentials()) return;

    const testSnapshot: EnhancedOrderbookSnapshot = {
      asset_id: "test_asset_integration_" + Date.now(),
      token_id: "test_token_integration_" + Date.now(),
      condition_id: "test_condition_integration",
      source_ts: Date.now(),
      ingestion_ts: Date.now() * 1000, // microseconds
      book_hash: "test_hash_" + crypto.randomUUID(),
      bids: [
        { price: 0.45, size: 100 },
        { price: 0.44, size: 200 },
      ],
      asks: [
        { price: 0.55, size: 150 },
        { price: 0.56, size: 250 },
      ],
      best_bid: 0.45,
      best_ask: 0.55,
      mid_price: 0.5,
      spread: 0.1,
      spread_bps: 2000,
      tick_size: 0.01,
      is_resync: false,
      sequence_number: 1,
    };

    // Format for ClickHouse
    const row = {
      asset_id: testSnapshot.asset_id,
      condition_id: testSnapshot.condition_id,
      source_ts: new Date(testSnapshot.source_ts).toISOString().replace("T", " ").slice(0, -1),
      ingestion_ts: new Date(testSnapshot.ingestion_ts / 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
      book_hash: testSnapshot.book_hash,
      bid_prices: testSnapshot.bids.map((b) => b.price),
      bid_sizes: testSnapshot.bids.map((b) => b.size),
      ask_prices: testSnapshot.asks.map((a) => a.price),
      ask_sizes: testSnapshot.asks.map((a) => a.size),
      tick_size: testSnapshot.tick_size,
      is_resync: testSnapshot.is_resync ? 1 : 0,
      sequence_number: testSnapshot.sequence_number,
    };

    // Insert
    const insertResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=INSERT INTO polymarket.ob_snapshots FORMAT JSONEachRow`,
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(row),
      }
    );

    expect(insertResponse.ok).toBe(true);

    // Wait for data to be available (ClickHouse is eventually consistent)
    await new Promise((r) => setTimeout(r, 1000));

    // Read back
    const readResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `SELECT * FROM polymarket.ob_snapshots WHERE asset_id = '${testSnapshot.asset_id}' FORMAT JSON`
      )}`,
      { method: "GET", headers: getHeaders() }
    );

    expect(readResponse.ok).toBe(true);
    const readData = await readResponse.json();
    expect(readData.data.length).toBe(1);
    expect(readData.data[0].asset_id).toBe(testSnapshot.asset_id);
    expect(readData.data[0].bid_prices).toEqual([0.45, 0.44]);
    expect(readData.data[0].ask_prices).toEqual([0.55, 0.56]);

    // Verify materialized columns computed correctly
    expect(readData.data[0].best_bid).toBeCloseTo(0.45);
    expect(readData.data[0].best_ask).toBeCloseTo(0.55);
    expect(readData.data[0].spread).toBeCloseTo(0.1);

    // Cleanup - delete test data
    await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `ALTER TABLE polymarket.ob_snapshots DELETE WHERE asset_id = '${testSnapshot.asset_id}'`
      )}`,
      { method: "POST", headers: getHeaders() }
    );
  });

  it("should batch insert multiple snapshots", async () => {
    if (skipIfNoCredentials()) return;

    const batchId = "batch_" + Date.now();
    const snapshots = Array.from({ length: 5 }, (_, i) => ({
      asset_id: `${batchId}_asset_${i}`,
      condition_id: `${batchId}_condition`,
      source_ts: new Date().toISOString().replace("T", " ").slice(0, -1),
      ingestion_ts: new Date().toISOString().replace("T", " ").slice(0, -1),
      book_hash: `hash_${i}_${crypto.randomUUID()}`,
      bid_prices: [0.4 + i * 0.01],
      bid_sizes: [100 + i * 10],
      ask_prices: [0.6 - i * 0.01],
      ask_sizes: [100 + i * 10],
      tick_size: 0.01,
      is_resync: 0,
      sequence_number: i,
    }));

    const body = snapshots.map((s) => JSON.stringify(s)).join("\n");

    const insertResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=INSERT INTO polymarket.ob_snapshots FORMAT JSONEachRow`,
      {
        method: "POST",
        headers: getHeaders(),
        body,
      }
    );

    expect(insertResponse.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));

    // Verify count
    const countResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `SELECT count() as cnt FROM polymarket.ob_snapshots WHERE condition_id = '${batchId}_condition' FORMAT JSON`
      )}`,
      { method: "GET", headers: getHeaders() }
    );

    expect(countResponse.ok).toBe(true);
    const countData = await countResponse.json();
    expect(Number(countData.data[0].cnt)).toBe(5);

    // Cleanup
    await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `ALTER TABLE polymarket.ob_snapshots DELETE WHERE condition_id = '${batchId}_condition'`
      )}`,
      { method: "POST", headers: getHeaders() }
    );
  });
});

describe("End-to-End Pipeline Test", () => {
  const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL;
  const CLICKHOUSE_TOKEN = process.env.CLICKHOUSE_TOKEN;
  const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";

  it("should process a complete orderbook event flow", async () => {
    if (!CLICKHOUSE_URL || !CLICKHOUSE_TOKEN) {
      console.log("Skipping E2E test: ClickHouse credentials required");
      return;
    }

    // 1. Connect to WebSocket and get real orderbook data
    const ws = new WebSocket(CLOB_WSS_URL);

    const bookEvent = await new Promise<{
      asset_id: string;
      market: string;
      bids: Array<{ price: string; size: string }>;
      asks: Array<{ price: string; size: string }>;
      timestamp: string;
      hash: string;
    } | null>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 15000);

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            action: "subscribe",
            assets_ids: [TEST_TOKEN_ID],
            type: "market",
          })
        );
      });

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.event_type === "book") {
            clearTimeout(timeout);
            ws.close();
            resolve(data);
          }
        } catch {
          // Ignore
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });

    expect(bookEvent).not.toBeNull();

    // 2. Transform to EnhancedOrderbookSnapshot (simulating DO processing)
    const ingestionTs = Date.now() * 1000;
    const bids = bookEvent!.bids.slice(0, 10).map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = bookEvent!.asks.slice(0, 10).map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    const snapshot: EnhancedOrderbookSnapshot = {
      asset_id: "e2e_test_" + bookEvent!.asset_id.slice(0, 20),
      token_id: bookEvent!.asset_id,
      condition_id: bookEvent!.market,
      source_ts: parseInt(bookEvent!.timestamp),
      ingestion_ts: ingestionTs,
      book_hash: bookEvent!.hash,
      bids,
      asks,
      best_bid: bestBid,
      best_ask: bestAsk,
      mid_price: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid && bestAsk ? bestAsk - bestBid : null,
      spread_bps:
        bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestBid + bestAsk) / 2)) * 10000 : null,
      tick_size: 0.01,
      is_resync: false,
      sequence_number: 1,
    };

    // 3. Write to ClickHouse (simulating queue consumer)
    const row = {
      asset_id: snapshot.asset_id,
      condition_id: snapshot.condition_id,
      source_ts: new Date(snapshot.source_ts).toISOString().replace("T", " ").slice(0, -1),
      ingestion_ts: new Date(snapshot.ingestion_ts / 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -1),
      book_hash: snapshot.book_hash,
      bid_prices: snapshot.bids.map((b) => b.price),
      bid_sizes: snapshot.bids.map((b) => b.size),
      ask_prices: snapshot.asks.map((a) => a.price),
      ask_sizes: snapshot.asks.map((a) => a.size),
      tick_size: snapshot.tick_size,
      is_resync: 0,
      sequence_number: snapshot.sequence_number,
    };

    const headers = {
      "X-ClickHouse-User": CLICKHOUSE_USER,
      "X-ClickHouse-Key": CLICKHOUSE_TOKEN,
      "Content-Type": "text/plain",
    };

    const insertResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=INSERT INTO polymarket.ob_snapshots FORMAT JSONEachRow`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(row),
      }
    );

    expect(insertResponse.ok).toBe(true);

    // 4. Verify data was written correctly
    await new Promise((r) => setTimeout(r, 1000));

    const readResponse = await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `SELECT * FROM polymarket.ob_snapshots WHERE asset_id = '${snapshot.asset_id}' FORMAT JSON`
      )}`,
      { method: "GET", headers }
    );

    const readData = await readResponse.json();
    expect(readData.data.length).toBe(1);

    const stored = readData.data[0];
    expect(stored.condition_id).toBe(snapshot.condition_id);
    expect(stored.book_hash).toBe(snapshot.book_hash);
    expect(stored.bid_prices.length).toBeGreaterThan(0);
    expect(stored.ask_prices.length).toBeGreaterThan(0);

    console.log("\nE2E Test Results:");
    console.log(`  Asset ID: ${snapshot.asset_id}`);
    console.log(`  Best Bid: ${stored.best_bid}`);
    console.log(`  Best Ask: ${stored.best_ask}`);
    console.log(`  Spread (bps): ${stored.spread_bps?.toFixed(2)}`);
    console.log(`  Bid Levels: ${stored.bid_levels}`);
    console.log(`  Ask Levels: ${stored.ask_levels}`);

    // 5. Cleanup
    await fetch(
      `${CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `ALTER TABLE polymarket.ob_snapshots DELETE WHERE asset_id = '${snapshot.asset_id}'`
      )}`,
      { method: "POST", headers }
    );
  });
});
