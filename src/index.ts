import { Hono, Context, Next } from "hono";
import { Env, GoldskyTradeEvent } from "./types";
import type {
  BBOSnapshot,
  GapBackfillJob,
  TradeTick,
  OrderbookLevelChange,
  FullL2Snapshot,
} from "./types/orderbook";
import { OrderbookManager } from "./durable-objects/orderbook-manager";
import { snapshotConsumer } from "./consumers/snapshot-consumer";
import { gapBackfillConsumer } from "./consumers/gap-backfill-consumer";
import { tradeTickConsumer } from "./consumers/trade-tick-consumer";
import { levelChangeConsumer } from "./consumers/level-change-consumer";
import { fullL2SnapshotConsumer } from "./consumers/full-l2-snapshot-consumer";
import { MarketLifecycleService, type MarketLifecycleWebhook } from "./services/market-lifecycle";
import { DB_CONFIG } from "./config/database";

/**
 * Load lifecycle webhooks from KV storage (parallel)
 */
async function loadLifecycleWebhooks(env: Env): Promise<MarketLifecycleWebhook[]> {
  const list = await env.MARKET_CACHE.list({ prefix: "lifecycle_webhook_" });

  const results = await Promise.all(
    list.keys.map(async (key) => {
      const data = await env.MARKET_CACHE.get(key.name);
      if (!data) return null;
      try {
        return JSON.parse(data) as MarketLifecycleWebhook;
      } catch {
        return null;
      }
    })
  );

  return results.filter((w): w is MarketLifecycleWebhook => w !== null);
}

/**
 * Auth middleware for API endpoints
 */
const authMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/goldsky", authMiddleware, async (c) => {
  const body = await c.req.json();

  // Handle both single event and array of events
  const events: GoldskyTradeEvent[] = Array.isArray(body) ? body : [body];

  console.log(`Received ${events.length} events from Goldsky`);

  const subscribedAssets: string[] = [];
  let cacheHits = 0;

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
    let negRisk = false;
    let orderMinSize = 0;

    if (cached) {
      try {
        const metadata = JSON.parse(cached);
        conditionId = metadata.condition_id || activeAssetId;
        tickSize = metadata.order_price_min_tick_size || 0.01;
        negRisk = metadata.neg_risk === 1 || metadata.neg_risk === true;
        orderMinSize = metadata.order_min_size || 0;
        // Check if market has ended
        if (metadata.end_date) {
          marketEnded = new Date(metadata.end_date) < new Date();
        }
        cacheHits++;
      } catch {
        // Use defaults if parse fails
      }
    }
    // On cache miss, use defaults - metadata will be synced by 5-minute cron

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
            neg_risk: negRisk,
            order_min_size: orderMinSize,
          }),
        })
      );
      subscribedAssets.push(activeAssetId);
    }
  }

  return c.json({
    status: "ok",
    events_received: events.length,
    subscriptions_triggered: subscribedAssets.length,
    cache_hits: cacheHits,
  });
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// ============================================================
// Low-Latency Trigger Management API
// ============================================================

async function proxyToDO(
  c: Context<{ Bindings: Env }>,
  endpoint: string,
  method: string = "GET"
): Promise<Response> {
  const conditionId = c.req.param("condition_id");
  const doId = c.env.ORDERBOOK_MANAGER.idFromName(conditionId);
  const stub = c.env.ORDERBOOK_MANAGER.get(doId);

  const body = method !== "GET" ? await c.req.text() : undefined;
  const response = await stub.fetch(`http://do${endpoint}`, {
    method: method === "DELETE" ? "POST" : method,
    headers: method !== "GET" ? { "Content-Type": "application/json" } : undefined,
    body,
  });

  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

app.get("/triggers/:condition_id", authMiddleware, (c) => proxyToDO(c, "/triggers"));
app.post("/triggers/:condition_id", authMiddleware, (c) => proxyToDO(c, "/triggers", "POST"));
app.delete("/triggers/:condition_id", authMiddleware, (c) => proxyToDO(c, "/triggers/delete", "DELETE"));

// ============================================================
// Market Lifecycle Webhooks (Resolution & New Markets)
// ============================================================

app.post("/lifecycle/webhooks", authMiddleware, async (c) => {
  const webhook = (await c.req.json()) as MarketLifecycleWebhook;

  if (!webhook.url || !webhook.event_types || webhook.event_types.length === 0) {
    return c.json({ error: "Missing required fields: url, event_types" }, 400);
  }

  // Validate event types
  const validTypes = ["MARKET_RESOLVED", "NEW_MARKET"];
  for (const t of webhook.event_types) {
    if (!validTypes.includes(t)) {
      return c.json({ error: `Invalid event_type: ${t}` }, 400);
    }
  }

  // Store in KV for persistence
  const webhookId = `lifecycle_webhook_${Date.now()}`;
  await c.env.MARKET_CACHE.put(webhookId, JSON.stringify(webhook), { expirationTtl: 86400 * 30 });

  return c.json({ status: "registered", webhook_id: webhookId, event_types: webhook.event_types });
});

app.get("/lifecycle/webhooks", authMiddleware, async (c) => {
  const webhooks = await loadLifecycleWebhooks(c.env);
  return c.json({ webhooks, count: webhooks.length });
});

app.post("/lifecycle/check", authMiddleware, async (c) => {
  const lifecycle = new MarketLifecycleService(c.env);
  const webhooks = await loadLifecycleWebhooks(c.env);
  for (const wh of webhooks) {
    lifecycle.registerWebhook(wh);
  }

  const results = await lifecycle.runCheck();
  return c.json({ status: "ok", ...results });
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

    // 4. Cleanup (using lightweight delete instead of mutation for better performance)
    await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(
        `DELETE FROM ${DB_CONFIG.DATABASE}.ob_snapshots WHERE asset_id = '${testId}'`
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

app.post("/admin/migrate", authMiddleware, async (c) => {
  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
    "Content-Type": "text/plain",
  };

  const statements = [
    // ob_snapshots table (uses Decimal128 for price precision)
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_snapshots (
      asset_id String,
      condition_id String,
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      book_hash String,
      bid_prices Array(Decimal128(18)),
      bid_sizes Array(Float64),
      ask_prices Array(Decimal128(18)),
      ask_sizes Array(Float64),
      tick_size Decimal128(18),
      is_resync UInt8 DEFAULT 0,
      sequence_number UInt64,
      neg_risk UInt8 DEFAULT 0,
      order_min_size Float64 DEFAULT 0,
      best_bid Decimal128(18) MATERIALIZED if(length(bid_prices) > 0, bid_prices[1], toDecimal128(0, 18)),
      best_ask Decimal128(18) MATERIALIZED if(length(ask_prices) > 0, ask_prices[1], toDecimal128(0, 18)),
      mid_price Decimal128(18) MATERIALIZED if(length(bid_prices) > 0 AND length(ask_prices) > 0, (bid_prices[1] + ask_prices[1]) / 2, toDecimal128(0, 18)),
      spread Decimal128(18) MATERIALIZED if(length(ask_prices) > 0 AND length(bid_prices) > 0, ask_prices[1] - bid_prices[1], toDecimal128(0, 18)),
      spread_bps Float64 MATERIALIZED if(length(bid_prices) > 0 AND length(ask_prices) > 0 AND (bid_prices[1] + ask_prices[1]) > toDecimal128(0, 18), toFloat64((ask_prices[1] - bid_prices[1]) / ((bid_prices[1] + ask_prices[1]) / 2)) * 10000, 0),
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
    // Uses Decimal128(18) for price to avoid floating-point precision errors
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.trade_ticks (
      asset_id String,
      condition_id String,
      trade_id String,
      price Decimal128(18),
      size Float64,
      side LowCardinality(String),
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts),
      notional Decimal128(18) MATERIALIZED price * toDecimal128(size, 18)
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

// Export Durable Objects
export { OrderbookManager };

async function queueHandler(batch: MessageBatch, env: Env) {
  const queueName = batch.queue;

  switch (queueName) {
    case "orderbook-snapshot-queue":
      await snapshotConsumer(batch as MessageBatch<BBOSnapshot>, env);
      break;
    case "gap-backfill-queue":
      await gapBackfillConsumer(batch as MessageBatch<GapBackfillJob>, env);
      break;
    case "trade-tick-queue":
      await tradeTickConsumer(batch as MessageBatch<TradeTick>, env);
      break;
    case "level-change-queue":
      await levelChangeConsumer(batch as MessageBatch<OrderbookLevelChange>, env);
      break;
    case "full-l2-queue":
      await fullL2SnapshotConsumer(batch as MessageBatch<FullL2Snapshot>, env);
      break;
  }
}

async function scheduledHandler(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
) {
  const now = new Date().toISOString();

  // Market lifecycle check every 5 minutes (cron: "*/5 * * * *")
  if (event.cron === "*/5 * * * *") {
    console.log("[Scheduled] Running market lifecycle check at", now);
    const lifecycle = new MarketLifecycleService(env);

    // Load webhooks from KV
    const webhooks = await loadLifecycleWebhooks(env);
    for (const wh of webhooks) {
      lifecycle.registerWebhook(wh);
    }

    ctx.waitUntil(
      lifecycle.runCheck().then((results) => {
        console.log(
          `[Scheduled] Lifecycle check complete: ${results.resolutions} resolutions, ${results.new_markets} new markets, ${results.metadata_synced} metadata synced`
        );
      })
    );
  }
}

export default {
  fetch: app.fetch,
  queue: queueHandler,
  scheduled: scheduledHandler,
};
