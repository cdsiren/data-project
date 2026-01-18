import { Hono } from "hono";
import { Env, GoldskyTradeEvent, MetadataFetchJob } from "./types";
import type {
  EnhancedOrderbookSnapshot,
  GapBackfillJob,
  TradeTick,
  AggregatedSnapshot,
  RealtimeTick,
} from "./types/orderbook";
import { OrderbookManager } from "./durable-objects/orderbook-manager";
import { SnapshotAggregator } from "./durable-objects/snapshot-aggregator";
import { metadataConsumer } from "./consumers/metadata-consumer";
import { snapshotConsumer } from "./consumers/snapshot-consumer";
import { gapBackfillConsumer } from "./consumers/gap-backfill-consumer";
import { tradeTickConsumer } from "./consumers/trade-tick-consumer";
import { aggregatedSnapshotConsumer } from "./consumers/aggregated-snapshot-consumer";
import { realtimeTickConsumer } from "./consumers/realtime-tick-consumer";
import { R2ArchivalService, type ArchivalJob } from "./services/r2-archival";
import { DB_CONFIG } from "./config/database";

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/goldsky", async (c) => {
  // Verify API key
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();

  // Handle both single event and array of events
  const events: GoldskyTradeEvent[] = Array.isArray(body) ? body : [body];

  console.log(`Received ${events.length} events from Goldsky`);

  const queuedJobs: string[] = [];
  const subscribedAssets: string[] = [];

  for (const event of events) {
    // Extract active asset ID (the one that's not "0")
    const activeAssetId =
      event.maker_asset_id !== "0"
        ? event.maker_asset_id
        : event.taker_asset_id;

    // Check cache for market metadata using clob_token_id
    const cacheKey = `market:${activeAssetId}`;
    const cached = await c.env.MARKET_CACHE.get(cacheKey);

    let conditionId = activeAssetId; // Default to asset ID
    let tickSize = 0.01;
    let marketEnded = false;

    if (cached) {
      try {
        const metadata = JSON.parse(cached);
        conditionId = metadata.condition_id || activeAssetId;
        tickSize = metadata.order_price_min_tick_size || 0.01;
        // Check if market has ended
        if (metadata.end_date) {
          marketEnded = new Date(metadata.end_date) < new Date();
        }
      } catch {
        // Use defaults if parse fails
      }
    } else {
      // Queue metadata fetch on cache miss
      const job: MetadataFetchJob = {
        clob_token_id: activeAssetId,
      };
      c.executionCtx.waitUntil(c.env.METADATA_QUEUE.send(job));
      queuedJobs.push(activeAssetId);
    }

    // Subscribe to orderbook WebSocket if market hasn't ended
    if (!marketEnded) {
      const doId = c.env.ORDERBOOK_MANAGER.idFromName(conditionId);
      const stub = c.env.ORDERBOOK_MANAGER.get(doId);
      c.executionCtx.waitUntil(
        stub.fetch("http://do/subscribe", {
          method: "POST",
          body: JSON.stringify({
            condition_id: conditionId,
            token_ids: [activeAssetId],
            tick_size: tickSize,
          }),
        })
      );
      subscribedAssets.push(activeAssetId);
    }
  }

  return c.json({
    status: "ok",
    events_received: events.length,
    jobs_queued: queuedJobs.length,
    subscriptions_triggered: subscribedAssets.length,
    cached: events.length - queuedJobs.length,
  });
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// ============================================================
// Test Endpoints (for integration testing)
// ============================================================

app.get("/test/websocket", async (c) => {
  const wsUrl = c.env.CLOB_WSS_URL;
  const testTokenId =
    c.req.query("token_id") ||
    "21742633143463906290569050155826241533067272736897614950488156847949938836455";

  try {
    const ws = new WebSocket(wsUrl);

    const result = await new Promise<{
      connected: boolean;
      subscribed: boolean;
      receivedBook: boolean;
      bookData: unknown;
      error?: string;
      messages?: string[];
      closeCode?: number;
      closeReason?: string;
    }>((resolve) => {
      const state = {
        connected: false,
        subscribed: false,
        receivedBook: false,
        bookData: null as unknown,
      };

      const timeout = setTimeout(() => {
        ws.close();
        resolve({ ...state, error: "Timeout after 15s" });
      }, 15000);

      ws.addEventListener("open", () => {
        state.connected = true;
        ws.send(
          JSON.stringify({
            assets_ids: [testTokenId],
            type: "market",
          })
        );
        state.subscribed = true;
      });

      const messages: string[] = [];
      ws.addEventListener("message", (event) => {
        const rawData = event.data as string;
        messages.push(rawData.slice(0, 200));
        try {
          const data = JSON.parse(rawData);
          if (data.event_type === "book") {
            state.receivedBook = true;
            state.bookData = {
              asset_id: data.asset_id,
              market: data.market,
              bids_count: data.bids?.length || 0,
              asks_count: data.asks?.length || 0,
              hash: data.hash,
              timestamp: data.timestamp,
            };
            clearTimeout(timeout);
            ws.close();
            resolve({ ...state, messages });
          }
        } catch {
          // Capture non-JSON messages too
        }
      });

      ws.addEventListener("close", (e) => {
        resolve({
          ...state,
          messages,
          closeCode: e.code,
          closeReason: e.reason,
        });
      });

      ws.addEventListener("error", (e) => {
        clearTimeout(timeout);
        ws.close();
        resolve({ ...state, error: String(e) });
      });
    });

    return c.json({
      test: "websocket",
      status: result.receivedBook ? "pass" : "fail",
      wsUrl,
      tokenId: testTokenId,
      result,
    });
  } catch (error) {
    return c.json(
      {
        test: "websocket",
        status: "fail",
        error: String(error),
      },
      500
    );
  }
});

app.get("/test/clickhouse", async (c) => {
  const testId = `test_${Date.now()}`;

  try {
    const headers = {
      "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
      "Content-Type": "text/plain",
    };

    // 1. Test connectivity
    const pingResponse = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=SELECT 1 FORMAT JSON`,
      { method: "GET", headers }
    );

    if (!pingResponse.ok) {
      return c.json(
        {
          test: "clickhouse",
          status: "fail",
          step: "connectivity",
          error: await pingResponse.text(),
        },
        500
      );
    }

    // 2. Test write
    const testRow = {
      asset_id: testId,
      condition_id: "test_condition",
      source_ts: new Date().toISOString().replace("T", " ").slice(0, -1),
      ingestion_ts: new Date().toISOString().replace("T", " ").slice(0, -1),
      book_hash: `hash_${testId}`,
      bid_prices: [0.45, 0.44],
      bid_sizes: [100, 200],
      ask_prices: [0.55, 0.56],
      ask_sizes: [150, 250],
      tick_size: 0.01,
      is_resync: 0,
      sequence_number: 1,
    };

    const insertResponse = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.ob_snapshots FORMAT JSONEachRow`,
      { method: "POST", headers, body: JSON.stringify(testRow) }
    );

    if (!insertResponse.ok) {
      return c.json(
        {
          test: "clickhouse",
          status: "fail",
          step: "insert",
          error: await insertResponse.text(),
        },
        500
      );
    }

    // 3. Wait and read back
    await new Promise((r) => setTimeout(r, 500));

    const readResponse = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `SELECT * FROM ${DB_CONFIG.DATABASE}.ob_snapshots WHERE asset_id = '${testId}' FORMAT JSON`
      )}`,
      { method: "GET", headers }
    );

    if (!readResponse.ok) {
      return c.json(
        {
          test: "clickhouse",
          status: "fail",
          step: "read",
          error: await readResponse.text(),
        },
        500
      );
    }

    const readData = (await readResponse.json()) as {
      data: Array<Record<string, unknown>>;
    };

    // 4. Cleanup
    await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `ALTER TABLE ${DB_CONFIG.DATABASE}.ob_snapshots DELETE WHERE asset_id = '${testId}'`
      )}`,
      { method: "POST", headers }
    );

    return c.json({
      test: "clickhouse",
      status: readData.data.length === 1 ? "pass" : "fail",
      steps: {
        connectivity: "ok",
        insert: "ok",
        read: readData.data.length === 1 ? "ok" : "no data found",
        cleanup: "ok",
      },
      data: readData.data[0] || null,
    });
  } catch (error) {
    return c.json(
      {
        test: "clickhouse",
        status: "fail",
        error: String(error),
      },
      500
    );
  }
});

app.post("/admin/migrate", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
    "Content-Type": "text/plain",
  };

  const statements = [
    // ob_snapshots table
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_snapshots (
      asset_id String,
      condition_id String,
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      book_hash String,
      bid_prices Array(Float64),
      bid_sizes Array(Float64),
      ask_prices Array(Float64),
      ask_sizes Array(Float64),
      tick_size Float64,
      is_resync UInt8 DEFAULT 0,
      sequence_number UInt64,
      best_bid Float64 MATERIALIZED if(length(bid_prices) > 0, bid_prices[1], 0),
      best_ask Float64 MATERIALIZED if(length(ask_prices) > 0, ask_prices[1], 0),
      mid_price Float64 MATERIALIZED if(length(bid_prices) > 0 AND length(ask_prices) > 0, (bid_prices[1] + ask_prices[1]) / 2, 0),
      spread Float64 MATERIALIZED if(length(ask_prices) > 0 AND length(bid_prices) > 0, ask_prices[1] - bid_prices[1], 0),
      spread_bps Float64 MATERIALIZED if(length(bid_prices) > 0 AND length(ask_prices) > 0 AND (bid_prices[1] + ask_prices[1]) > 0, ((ask_prices[1] - bid_prices[1]) / ((bid_prices[1] + ask_prices[1]) / 2)) * 10000, 0),
      total_bid_depth Float64 MATERIALIZED arraySum(bid_sizes),
      total_ask_depth Float64 MATERIALIZED arraySum(ask_sizes),
      bid_levels UInt16 MATERIALIZED toUInt16(length(bid_prices)),
      ask_levels UInt16 MATERIALIZED toUInt16(length(ask_prices)),
      book_imbalance Float64 MATERIALIZED if(arraySum(bid_sizes) + arraySum(ask_sizes) > 0, (arraySum(bid_sizes) - arraySum(ask_sizes)) / (arraySum(bid_sizes) + arraySum(ask_sizes)), 0)
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(source_ts) ORDER BY (asset_id, source_ts, ingestion_ts) SETTINGS index_granularity = 8192`,

    // ob_gap_events table
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_gap_events (
      asset_id String,
      detected_at DateTime64(3, 'UTC'),
      last_known_hash String,
      new_hash String,
      gap_duration_ms UInt64,
      resolution Enum8('PENDING' = 0, 'RESOLVED' = 1, 'FAILED' = 2) DEFAULT 'PENDING',
      resolved_at Nullable(DateTime64(3, 'UTC')),
      snapshots_recovered UInt32 DEFAULT 0
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(detected_at) ORDER BY (asset_id, detected_at)`,

    // ob_latency table
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_latency (
      asset_id String,
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts),
      event_type LowCardinality(String)
    ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(source_ts) ORDER BY (source_ts, asset_id)`,

    // trade_ticks table for execution-level data (critical for backtesting)
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.trade_ticks (
      asset_id String,
      condition_id String,
      trade_id String,
      price Float64,
      size Float64,
      side LowCardinality(String),
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts),
      notional Float64 MATERIALIZED price * size
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(source_ts) ORDER BY (asset_id, source_ts)`,
  ];

  const results: Array<{ statement: string; status: string; error?: string }> =
    [];

  for (const sql of statements) {
    try {
      const response = await fetch(
        `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(sql)}`,
        { method: "POST", headers }
      );
      if (response.ok) {
        results.push({ statement: sql.slice(0, 50) + "...", status: "ok" });
      } else {
        const error = await response.text();
        results.push({
          statement: sql.slice(0, 50) + "...",
          status: "error",
          error,
        });
      }
    } catch (error) {
      results.push({
        statement: sql.slice(0, 50) + "...",
        status: "error",
        error: String(error),
      });
    }
  }

  const allOk = results.every((r) => r.status === "ok");
  return c.json({ status: allOk ? "migrated" : "partial", results });
});

app.get("/test/all", async (c) => {
  const results = {
    timestamp: new Date().toISOString(),
    tests: {} as Record<string, unknown>,
  };

  // Run all tests in parallel
  const [wsResult, chResult] = await Promise.all([
    fetch(new URL("/test/websocket", c.req.url)).then((r) => r.json()) as Promise<{ status: string }>,
    fetch(new URL("/test/clickhouse", c.req.url)).then((r) => r.json()) as Promise<{ status: string }>,
  ]);

  results.tests = {
    websocket: wsResult,
    clickhouse: chResult,
  };

  const allPassed = [wsResult, chResult].every(
    (r) => r.status === "pass"
  );

  return c.json({
    status: allPassed ? "all_pass" : "some_failed",
    ...results,
  });
});

// ============================================================
// Admin Endpoints - Archival Management
// ============================================================

app.get("/admin/archive/status", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const archival = new R2ArchivalService(c.env);
    const partitions = await archival.listArchivedPartitions();
    return c.json({
      status: "ok",
      archived_partitions: partitions,
      total_partitions: partitions.length,
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

app.post("/admin/archive/trigger", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const archival = new R2ArchivalService(c.env);
    const results = await archival.runScheduledArchival();
    return c.json({
      status: "ok",
      results,
      partitions_archived: results.length,
    });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

app.get("/admin/aggregator/status", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const assetId = c.req.query("asset_id");
  if (!assetId) {
    return c.json({ error: "asset_id query param required" }, 400);
  }

  try {
    const id = c.env.SNAPSHOT_AGGREGATOR.idFromName(assetId);
    const stub = c.env.SNAPSHOT_AGGREGATOR.get(id);
    const response = await stub.fetch(new Request("http://internal/status"));
    const data = await response.json();
    return c.json({ status: "ok", aggregator: data });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// Export Durable Objects
export { OrderbookManager };
export { SnapshotAggregator };

async function queueHandler(batch: MessageBatch, env: Env) {
  const queueName = batch.queue;

  switch (queueName) {
    case "metadata-fetch-queue":
      await metadataConsumer(batch as MessageBatch<MetadataFetchJob>, env);
      break;
    case "orderbook-snapshot-queue":
      await snapshotConsumer(
        batch as MessageBatch<EnhancedOrderbookSnapshot>,
        env
      );
      break;
    case "gap-backfill-queue":
      await gapBackfillConsumer(batch as MessageBatch<GapBackfillJob>, env);
      break;
    case "trade-tick-queue":
      await tradeTickConsumer(batch as MessageBatch<TradeTick>, env);
      break;
    case "aggregated-snapshot-queue":
      await aggregatedSnapshotConsumer(
        batch as MessageBatch<AggregatedSnapshot[]>,
        env
      );
      break;
    case "realtime-tick-queue":
      await realtimeTickConsumer(batch as MessageBatch<RealtimeTick>, env);
      break;
    case "archival-queue":
      const archival = new R2ArchivalService(env);
      for (const msg of batch.messages) {
        try {
          await archival.archivePartition(msg.body as ArchivalJob);
          msg.ack();
        } catch (error) {
          console.error("[Archival] Job failed:", error);
          msg.retry();
        }
      }
      break;
  }
}

async function scheduledHandler(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
) {
  console.log("[Scheduled] Running daily archival job at", new Date().toISOString());
  const archival = new R2ArchivalService(env);
  ctx.waitUntil(archival.runScheduledArchival());
}

export default {
  fetch: app.fetch,
  queue: queueHandler,
  scheduled: scheduledHandler,
};
