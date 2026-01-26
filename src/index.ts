import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { Env, DeadLetterMessage } from "./types";
import type {
  BBOSnapshot,
  GapBackfillJob,
  TradeTick,
  OrderbookLevelChange,
  FullL2Snapshot,
} from "./types/orderbook";
import { OrderbookManager } from "./durable-objects/orderbook-manager";
import { TriggerEventBuffer } from "./durable-objects/trigger-event-buffer";
import { snapshotConsumer } from "./consumers/snapshot-consumer";
import { gapBackfillConsumer } from "./consumers/gap-backfill-consumer";
import { tradeTickConsumer } from "./consumers/trade-tick-consumer";
import { levelChangeConsumer } from "./consumers/level-change-consumer";
import { fullL2SnapshotConsumer } from "./consumers/full-l2-snapshot-consumer";
import { deadLetterConsumer } from "./consumers/dead-letter-consumer";
import { MarketLifecycleService, type MarketLifecycleWebhook } from "./services/market-lifecycle";
import { MarketCacheService } from "./services/market-cache";
import { MarketCleanupService } from "./services/market-cleanup";
import { DB_CONFIG } from "./config/database";

// ============================================================
// SHARD CONFIGURATION
// Each shard = 1 DO instance = 1 WebSocket connection = max 450 assets
// This prevents rate limiting by distributing connections across shards
// ============================================================
const SHARD_COUNT = 25; // Supports ~11,250 assets (25 × 450)

/**
 * DJB2 hash function - consistent string hashing
 */
function djb2Hash(str: string): number {
  return Array.from(str).reduce(
    (acc, char, idx) => ((acc << 5) - acc) + char.charCodeAt(0) + idx,
    0
  );
}

/**
 * Deterministic shard assignment based on MARKET (condition_id).
 * This ensures YES and NO tokens for the same market are ALWAYS on the same shard,
 * which is CRITICAL for arbitrage triggers that need both sides' BBO data.
 */
function getShardForMarket(conditionId: string): string {
  const hash = djb2Hash(conditionId);
  return `shard-${Math.abs(hash) % SHARD_COUNT}`;
}

// ============================================================
// Durable Object Location Hints
// ============================================================

/**
 * Location hint for Durable Objects - co-locate with Polymarket servers
 * Polymarket's primary servers are in eu-west-2 (London)
 * "weur" = Western Europe (closest Cloudflare region)
 */
const DO_LOCATION_HINT: DurableObjectLocationHint = "weur";

/**
 * Extended idFromName with location hint support
 * Note: locationHint is a newer Cloudflare feature, types may not include it yet
 */
interface DurableObjectNamespaceExt {
  idFromName(name: string, options?: { locationHint?: DurableObjectLocationHint }): DurableObjectId;
}

/**
 * Get OrderbookManager DO stub with location hint for low-latency Polymarket connection
 */
function getOrderbookManagerStub(env: Env, shardId: string): DurableObjectStub {
  const ns = env.ORDERBOOK_MANAGER as unknown as DurableObjectNamespaceExt;
  const doId = ns.idFromName(shardId, { locationHint: DO_LOCATION_HINT });
  return env.ORDERBOOK_MANAGER.get(doId);
}

/**
 * Get TriggerEventBuffer DO stub with location hint
 */
function getTriggerEventBufferStub(env: Env): DurableObjectStub {
  const ns = env.TRIGGER_EVENT_BUFFER as unknown as DurableObjectNamespaceExt;
  const doId = ns.idFromName("global", { locationHint: DO_LOCATION_HINT });
  return env.TRIGGER_EVENT_BUFFER.get(doId);
}

// ============================================================
// Shard Utilities
// ============================================================

interface ShardResult<T> {
  shard: string;
  index: number;
  result?: T;
  error?: string;
}

/**
 * Execute an operation across all shards in parallel.
 * Provides consistent error handling and result aggregation.
 */
async function forEachShard<T>(
  env: Env,
  operation: (stub: DurableObjectStub, shardId: string, index: number) => Promise<T>,
  options?: { continueOnError?: boolean }
): Promise<ShardResult<T>[]> {
  return Promise.all(
    Array.from({ length: SHARD_COUNT }, async (_, i) => {
      const shardId = `shard-${i}`;
      const stub = getOrderbookManagerStub(env, shardId);

      try {
        const result = await operation(stub, shardId, i);
        return { shard: shardId, index: i, result };
      } catch (error) {
        if (!options?.continueOnError) throw error;
        return { shard: shardId, index: i, error: String(error) };
      }
    })
  );
}

// ============================================================
// Market Subscription Utilities
// ============================================================

interface NewMarketEvent {
  condition_id: string;
  token_ids: string[];
  tick_size?: number;
  neg_risk: boolean;
  min_size?: number;
}

/**
 * Subscribe new markets to appropriate OrderbookManager shards.
 * Used by both manual lifecycle checks and scheduled cron jobs.
 */
async function subscribeNewMarkets(
  env: Env,
  events: NewMarketEvent[]
): Promise<{ subscribed: number; errors: string[] }> {
  let subscribed = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      const shardId = getShardForMarket(event.condition_id);
      const stub = getOrderbookManagerStub(env, shardId);

      await stub.fetch("http://do/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          condition_id: event.condition_id,
          token_ids: event.token_ids,
          tick_size: event.tick_size,
          neg_risk: event.neg_risk,
          order_min_size: event.min_size,
          market_source: "polymarket",
        }),
      });

      subscribed++;
    } catch (err) {
      errors.push(`${event.condition_id}: ${String(err)}`);
    }
  }

  return { subscribed, errors };
}

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
 * Auth middleware for API endpoints (uses VITE_DASHBOARD_API_KEY)
 */
const authMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.VITE_DASHBOARD_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// ============================================================
// Low-Latency Trigger Management API (Sharded)
// ============================================================

// List all triggers across all shards
app.get("/triggers", authMiddleware, async (c) => {
  const shardResults = await forEachShard(
    c.env,
    async (stub) => {
      const resp = await stub.fetch("http://do/triggers");
      return resp.json() as Promise<{ triggers: unknown[]; total: number }>;
    },
    { continueOnError: true }
  );

  const allTriggers = shardResults.flatMap((r) => r.result?.triggers ?? []);
  return c.json({
    triggers: allTriggers,
    total: allTriggers.length,
    shards: SHARD_COUNT,
  });
});

// Register a new trigger - routes to shard based on MARKET (condition_id)
// This ensures triggers are on the same shard as their assets (critical for arbitrage)
app.post("/triggers", authMiddleware, async (c) => {
  const body = await c.req.json();

  if (!body.asset_id) {
    return c.json({ error: "Missing required field: asset_id" }, 400);
  }

  // Determine condition_id for market-based shard routing
  let conditionId: string | null = body.condition_id || null;

  if (!conditionId) {
    // Look up condition_id from cache using service
    const marketCache = new MarketCacheService(c.env.MARKET_CACHE);
    conditionId = await marketCache.getConditionId(body.asset_id);
  }

  // RELIABILITY: Require condition_id for proper shard routing
  if (!conditionId) {
    return c.json(
      {
        error: "Cannot determine market (condition_id) for asset. " +
               "Either provide condition_id in request or ensure market metadata is cached.",
        hint: "Run /lifecycle/check to sync market metadata, or provide condition_id explicitly",
      },
      400
    );
  }

  // Route by MARKET to ensure trigger is on same shard as both YES/NO tokens
  const shardId = getShardForMarket(conditionId);
  const stub = getOrderbookManagerStub(c.env, shardId);

  const response = await stub.fetch("http://do/triggers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Delete a trigger - routes by MARKET (condition_id) to correct shard
app.delete("/triggers", authMiddleware, async (c) => {
  const body = await c.req.json();

  if (!body.trigger_id) {
    return c.json({ error: "Missing required field: trigger_id" }, 400);
  }

  // Need either condition_id or asset_id to route to correct shard
  if (!body.condition_id && !body.asset_id) {
    return c.json({ error: "Missing required field: condition_id or asset_id" }, 400);
  }

  // Determine condition_id for market-based shard routing
  let conditionId: string | null = body.condition_id || null;

  if (!conditionId && body.asset_id) {
    // Look up condition_id from cache using service
    const marketCache = new MarketCacheService(c.env.MARKET_CACHE);
    conditionId = await marketCache.getConditionId(body.asset_id);
  }

  if (!conditionId) {
    return c.json(
      {
        error: "Cannot determine market (condition_id) for routing. " +
               "Provide condition_id or ensure market metadata is cached.",
      },
      400
    );
  }

  const shardId = getShardForMarket(conditionId);
  const stub = getOrderbookManagerStub(c.env, shardId);

  const response = await stub.fetch("http://do/triggers/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger_id: body.trigger_id }),
  });

  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
});

// ============================================================
// Shard Monitoring
// ============================================================

// Get status of all shards - health check and asset distribution
app.get("/shards/status", authMiddleware, async (c) => {
  interface ShardStatus {
    total_assets: number;
    connections: Array<{ connected: boolean; asset_count: number }>;
  }

  const shardResults = await forEachShard<ShardStatus>(
    c.env,
    async (stub) => {
      const resp = await stub.fetch("http://do/status");
      return resp.json() as Promise<ShardStatus>;
    },
    { continueOnError: true }
  );

  const statuses = shardResults.map((r) => ({
    shard: r.index,
    name: r.shard,
    total_assets: r.result?.total_assets ?? 0,
    connections: r.result?.connections ?? [],
    healthy: r.result?.connections?.some((conn) => conn.connected) ?? false,
    ...(r.error && { error: r.error }),
  }));

  const totalAssets = statuses.reduce((sum, s) => sum + s.total_assets, 0);
  const healthyShards = statuses.filter((s) => s.healthy).length;

  return c.json({
    summary: {
      total_shards: SHARD_COUNT,
      healthy_shards: healthyShards,
      total_assets: totalAssets,
      avg_assets_per_shard: Math.round(totalAssets / SHARD_COUNT),
    },
    shards: statuses,
  });
});

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

  // Subscribe new markets to OrderbookManager DOs
  const subscription = await subscribeNewMarkets(c.env, results.newMarketEvents);

  return c.json({
    status: "ok",
    ...results,
    subscribed: subscription.subscribed,
    subscription_errors: subscription.errors.length > 0 ? subscription.errors : undefined,
  });
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

    // ob_bbo table - tick-level BBO data (critical for triggers and backtesting)
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_bbo (
      asset_id String,
      condition_id String,
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      book_hash String,
      best_bid Decimal128(18),
      best_ask Decimal128(18),
      bid_size Float64,
      ask_size Float64,
      mid_price Decimal128(18),
      spread_bps Float64,
      tick_size Decimal128(18),
      is_resync UInt8 DEFAULT 0,
      sequence_number UInt64,
      neg_risk UInt8 DEFAULT 0,
      order_min_size Float64 DEFAULT 0,
      spread Decimal128(18) MATERIALIZED best_ask - best_bid,
      latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts)
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(source_ts) ORDER BY (asset_id, source_ts, ingestion_ts) TTL source_ts + INTERVAL 90 DAY SETTINGS index_granularity = 8192`,

    // ob_level_changes table - order flow data
    `CREATE TABLE IF NOT EXISTS ${DB_CONFIG.DATABASE}.ob_level_changes (
      asset_id String,
      condition_id String,
      source_ts DateTime64(3, 'UTC'),
      ingestion_ts DateTime64(6, 'UTC'),
      side LowCardinality(String),
      price Decimal128(18),
      old_size Float64,
      new_size Float64,
      size_delta Float64,
      change_type LowCardinality(String),
      book_hash String,
      sequence_number UInt64,
      latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts)
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(source_ts) ORDER BY (asset_id, source_ts, sequence_number) TTL source_ts + INTERVAL 30 DAY SETTINGS index_granularity = 8192`,
  ];

  // Materialized views for OHLC aggregation (run after base tables)
  const materializedViews = [
    // 1-minute OHLC bars - primary for strategy backtesting (180-day retention)
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m
    ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(minute)
    ORDER BY (asset_id, minute)
    TTL minute + INTERVAL 180 DAY DELETE
    SETTINGS index_granularity = 8192
    AS SELECT
      asset_id,
      condition_id,
      toStartOfMinute(source_ts) AS minute,
      argMinState(best_bid, source_ts) AS open_bid_state,
      maxState(best_bid) AS high_bid_state,
      minState(best_bid) AS low_bid_state,
      argMaxState(best_bid, source_ts) AS close_bid_state,
      argMinState(best_ask, source_ts) AS open_ask_state,
      maxState(best_ask) AS high_ask_state,
      minState(best_ask) AS low_ask_state,
      argMaxState(best_ask, source_ts) AS close_ask_state,
      sumState(mid_price * (bid_size + ask_size)) AS sum_price_volume_state,
      sumState(bid_size + ask_size) AS sum_volume_state,
      avgState(spread_bps) AS avg_spread_bps_state,
      minState(spread_bps) AS min_spread_bps_state,
      maxState(spread_bps) AS max_spread_bps_state,
      avgState(bid_size) AS avg_bid_size_state,
      avgState(ask_size) AS avg_ask_size_state,
      sumState(bid_size) AS total_bid_size_state,
      sumState(ask_size) AS total_ask_size_state,
      avgState(if(bid_size + ask_size > 0, (bid_size - ask_size) / (bid_size + ask_size), 0)) AS avg_imbalance_state,
      countState() AS tick_count_state,
      minState(source_ts) AS first_ts_state,
      maxState(source_ts) AS last_ts_state,
      argMinState(book_hash, source_ts) AS first_hash_state,
      argMaxState(book_hash, source_ts) AS last_hash_state,
      minState(sequence_number) AS sequence_start_state,
      maxState(sequence_number) AS sequence_end_state
    FROM ${DB_CONFIG.DATABASE}.ob_bbo
    WHERE best_bid > 0 AND best_ask > 0
    GROUP BY asset_id, condition_id, minute`,

    // 5-minute OHLC bars - longer-term analysis (365-day retention)
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${DB_CONFIG.DATABASE}.mv_ob_bbo_5m
    ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(interval_5m)
    ORDER BY (asset_id, interval_5m)
    TTL interval_5m + INTERVAL 365 DAY DELETE
    SETTINGS index_granularity = 8192
    AS SELECT
      asset_id,
      condition_id,
      toStartOfFiveMinutes(source_ts) AS interval_5m,
      argMinState(best_bid, source_ts) AS open_bid_state,
      maxState(best_bid) AS high_bid_state,
      minState(best_bid) AS low_bid_state,
      argMaxState(best_bid, source_ts) AS close_bid_state,
      argMinState(best_ask, source_ts) AS open_ask_state,
      maxState(best_ask) AS high_ask_state,
      minState(best_ask) AS low_ask_state,
      argMaxState(best_ask, source_ts) AS close_ask_state,
      sumState(mid_price * (bid_size + ask_size)) AS sum_price_volume_state,
      sumState(bid_size + ask_size) AS sum_volume_state,
      avgState(spread_bps) AS avg_spread_bps_state,
      minState(spread_bps) AS min_spread_bps_state,
      maxState(spread_bps) AS max_spread_bps_state,
      avgState(bid_size) AS avg_bid_size_state,
      avgState(ask_size) AS avg_ask_size_state,
      avgState(if(bid_size + ask_size > 0, (bid_size - ask_size) / (bid_size + ask_size), 0)) AS avg_imbalance_state,
      countState() AS tick_count_state,
      minState(source_ts) AS first_ts_state,
      maxState(source_ts) AS last_ts_state,
      argMinState(book_hash, source_ts) AS first_hash_state,
      argMaxState(book_hash, source_ts) AS last_hash_state
    FROM ${DB_CONFIG.DATABASE}.ob_bbo
    WHERE best_bid > 0 AND best_ask > 0
    GROUP BY asset_id, condition_id, interval_5m`,
  ];

  // Helper views for easy querying (apply Merge functions automatically)
  const helperViews = [
    `CREATE VIEW IF NOT EXISTS ${DB_CONFIG.DATABASE}.v_ob_bbo_1m AS
    SELECT
      asset_id, condition_id, minute,
      argMinMerge(open_bid_state) AS open_bid,
      maxMerge(high_bid_state) AS high_bid,
      minMerge(low_bid_state) AS low_bid,
      argMaxMerge(close_bid_state) AS close_bid,
      argMinMerge(open_ask_state) AS open_ask,
      maxMerge(high_ask_state) AS high_ask,
      minMerge(low_ask_state) AS low_ask,
      argMaxMerge(close_ask_state) AS close_ask,
      (argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2 AS open_mid,
      (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2 AS close_mid,
      if(sumMerge(sum_volume_state) > 0, sumMerge(sum_price_volume_state) / sumMerge(sum_volume_state), (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2) AS vwap_mid,
      avgMerge(avg_spread_bps_state) AS avg_spread_bps,
      minMerge(min_spread_bps_state) AS min_spread_bps,
      maxMerge(max_spread_bps_state) AS max_spread_bps,
      avgMerge(avg_bid_size_state) AS avg_bid_size,
      avgMerge(avg_ask_size_state) AS avg_ask_size,
      sumMerge(total_bid_size_state) AS total_bid_volume,
      sumMerge(total_ask_size_state) AS total_ask_volume,
      avgMerge(avg_imbalance_state) AS avg_imbalance,
      countMerge(tick_count_state) AS tick_count,
      minMerge(first_ts_state) AS first_ts,
      maxMerge(last_ts_state) AS last_ts
    FROM ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m
    GROUP BY asset_id, condition_id, minute`,

    `CREATE VIEW IF NOT EXISTS ${DB_CONFIG.DATABASE}.v_ob_bbo_5m AS
    SELECT
      asset_id, condition_id, interval_5m,
      argMinMerge(open_bid_state) AS open_bid,
      maxMerge(high_bid_state) AS high_bid,
      minMerge(low_bid_state) AS low_bid,
      argMaxMerge(close_bid_state) AS close_bid,
      argMinMerge(open_ask_state) AS open_ask,
      maxMerge(high_ask_state) AS high_ask,
      minMerge(low_ask_state) AS low_ask,
      argMaxMerge(close_ask_state) AS close_ask,
      (argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2 AS open_mid,
      (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2 AS close_mid,
      if(sumMerge(sum_volume_state) > 0, sumMerge(sum_price_volume_state) / sumMerge(sum_volume_state), (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2) AS vwap_mid,
      avgMerge(avg_spread_bps_state) AS avg_spread_bps,
      avgMerge(avg_bid_size_state) AS avg_bid_size,
      avgMerge(avg_ask_size_state) AS avg_ask_size,
      avgMerge(avg_imbalance_state) AS avg_imbalance,
      countMerge(tick_count_state) AS tick_count
    FROM ${DB_CONFIG.DATABASE}.mv_ob_bbo_5m
    GROUP BY asset_id, condition_id, interval_5m`,
  ];

  const results: Array<{ statement: string; status: string; error?: string }> =
    [];

  // Run base table migrations first
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

  // Run materialized views (depend on base tables)
  for (const sql of materializedViews) {
    try {
      const response = await fetch(
        `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(sql)}`,
        { method: "POST", headers }
      );
      if (response.ok) {
        results.push({ statement: sql.slice(0, 60) + "...", status: "ok" });
      } else {
        const error = await response.text();
        results.push({
          statement: sql.slice(0, 60) + "...",
          status: "error",
          error,
        });
      }
    } catch (error) {
      results.push({
        statement: sql.slice(0, 60) + "...",
        status: "error",
        error: String(error),
      });
    }
  }

  // Run helper views (depend on materialized views)
  for (const sql of helperViews) {
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

// ============================================================
// Bootstrap & Health Check Endpoints
// ============================================================

/**
 * One-time endpoint to backfill all active markets for orderbook monitoring.
 * The cron job only catches NEW markets going forward; this endpoint bootstraps
 * the system with all existing active markets.
 *
 * Usage:
 *   POST /admin/bootstrap-markets - Subscribe all active markets to shards
 *   POST /admin/bootstrap-markets?limit=100 - Limit number of markets to bootstrap
 */
app.post("/admin/bootstrap-markets", authMiddleware, async (c) => {
  const limit = parseInt(c.req.query("limit") || "1000", 10);

  try {
    // Fetch all active markets from Gamma API
    const response = await fetch(
      `${c.env.GAMMA_API_URL}/markets?active=true&closed=false&enableOrderBook=true&limit=${limit}`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      return c.json({ error: "Gamma API error", status: response.status }, 500);
    }

    interface GammaMarketBootstrap {
      conditionId: string;
      clobTokenIds: string;
      orderPriceMinTickSize: number;
      negRisk: boolean;
      orderMinSize: number;
      question: string;
    }

    const markets = (await response.json()) as GammaMarketBootstrap[];

    const results: Array<{
      condition_id: string;
      shard: string;
      tokens: number;
      status: string;
      error?: string;
    }> = [];

    let subscribed = 0;
    let failed = 0;

    // Subscribe each market to its appropriate shard
    for (const market of markets) {
      let tokenIds: string[] = [];
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch {
        tokenIds = [market.clobTokenIds];
      }

      const shardId = getShardForMarket(market.conditionId);
      const stub = getOrderbookManagerStub(c.env, shardId);

      try {
        await stub.fetch("http://do/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            condition_id: market.conditionId,
            token_ids: tokenIds,
            tick_size: market.orderPriceMinTickSize,
            neg_risk: market.negRisk,
            order_min_size: market.orderMinSize,
            market_source: "polymarket",
          }),
        });

        results.push({
          condition_id: market.conditionId,
          shard: shardId,
          tokens: tokenIds.length,
          status: "subscribed",
        });
        subscribed++;
      } catch (err) {
        results.push({
          condition_id: market.conditionId,
          shard: shardId,
          tokens: tokenIds.length,
          status: "failed",
          error: String(err),
        });
        failed++;
      }
    }

    return c.json({
      status: "complete",
      summary: {
        total_markets: markets.length,
        subscribed,
        failed,
        shards_used: new Set(results.map((r) => r.shard)).size,
      },
      results,
    });
  } catch (error) {
    return c.json({ error: "Bootstrap failed", details: String(error) }, 500);
  }
});

/**
 * Health check endpoint to verify markets are being monitored.
 * Queries all 25 shards for their subscription counts.
 *
 * Usage:
 *   GET /health/subscriptions - Get subscription status across all shards
 */
app.get("/health/subscriptions", authMiddleware, async (c) => {
  interface ShardStatus {
    total_assets: number;
    connections: Array<{ connected: boolean; asset_count: number }>;
  }

  const shardResults = await forEachShard<ShardStatus>(
    c.env,
    async (stub) => {
      const resp = await stub.fetch("http://do/status");
      return resp.json() as Promise<ShardStatus>;
    },
    { continueOnError: true }
  );

  const shardStatuses = shardResults.map((r) => {
    const activeConns = r.result?.connections?.filter((c) => c.connected).length ?? 0;
    const totalAssets = r.result?.total_assets ?? 0;
    return {
      shard: r.shard,
      total_assets: totalAssets,
      active_connections: activeConns,
      healthy: activeConns > 0 || totalAssets === 0,
      ...(r.error && { error: r.error }),
    };
  });

  const totalSubscriptions = shardStatuses.reduce((sum, s) => sum + s.total_assets, 0);
  const healthyShards = shardStatuses.filter((s) => s.healthy).length;
  const activeConnections = shardStatuses.reduce((sum, s) => sum + s.active_connections, 0);

  // Determine overall health status
  let status: "healthy" | "degraded" | "unhealthy";
  if (totalSubscriptions === 0) {
    status = "unhealthy";
  } else if (healthyShards < SHARD_COUNT) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return c.json({
    status,
    timestamp: new Date().toISOString(),
    summary: {
      total_subscriptions: totalSubscriptions,
      total_shards: SHARD_COUNT,
      healthy_shards: healthyShards,
      active_connections: activeConnections,
    },
    shards: shardStatuses,
    recommendations:
      totalSubscriptions === 0
        ? ["No markets subscribed. Run POST /admin/bootstrap-markets to subscribe existing markets."]
        : [],
  });
});

/**
 * Admin endpoint to delete all test triggers and clear event buffer.
 * Use this to clean up after testing and prepare for production.
 */
app.post("/admin/cleanup-test-data", authMiddleware, async (c) => {
  const results: Array<{ action: string; status: string; details?: string }> = [];

  // Delete all test triggers from all shards
  interface TriggerList {
    triggers: Array<{ id: string; metadata?: Record<string, string> }>;
  }

  const shardResults = await forEachShard<number>(
    c.env,
    async (stub) => {
      const listResp = await stub.fetch("http://do/triggers");
      const listData = await listResp.json() as TriggerList;
      let deleted = 0;

      for (const trigger of listData.triggers) {
        if (trigger.metadata?.test === "true") {
          await stub.fetch("http://do/triggers/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trigger_id: trigger.id }),
          });
          deleted++;
        }
      }
      return deleted;
    },
    { continueOnError: true }
  );

  const deletedTriggers = shardResults.reduce((sum, r) => sum + (r.result ?? 0), 0);
  const shardErrors = shardResults.filter((r) => r.error);

  for (const err of shardErrors) {
    results.push({ action: `delete_triggers_${err.shard}`, status: "error", details: err.error });
  }

  results.push({ action: "delete_test_triggers", status: "success", details: `${deletedTriggers} triggers deleted` });

  // Clear event buffer by requesting it to clear
  try {
    const stub = getTriggerEventBufferStub(c.env);
    await stub.fetch("http://do/clear", { method: "POST" });
    results.push({ action: "clear_event_buffer", status: "success" });
  } catch (error) {
    results.push({ action: "clear_event_buffer", status: "error", details: String(error) });
  }

  return c.json({
    status: "complete",
    results,
  });
});

/**
 * Production trigger definitions - wildcard triggers that fire on all markets.
 * These don't require specific asset IDs and will generate real-time events.
 */
const PRODUCTION_TRIGGERS = [
  // Price threshold triggers - fire when markets approach resolution
  {
    id_prefix: "prod_price_above",
    asset_id: "*",
    condition: { type: "PRICE_ABOVE", threshold: 0.90, side: "BID" },
    cooldown_ms: 10000,
    description: "Price above $0.90",
  },
  {
    id_prefix: "prod_price_below",
    asset_id: "*",
    condition: { type: "PRICE_BELOW", threshold: 0.10, side: "BID" },
    cooldown_ms: 10000,
    description: "Price below $0.10",
  },
  // Spread triggers - common in prediction markets
  {
    id_prefix: "prod_spread_wide",
    asset_id: "*",
    condition: { type: "SPREAD_WIDE", threshold: 300 },
    cooldown_ms: 30000,
    description: "Spread wider than 300 bps",
  },
  {
    id_prefix: "prod_spread_narrow",
    asset_id: "*",
    condition: { type: "SPREAD_NARROW", threshold: 50 },
    cooldown_ms: 15000,
    description: "Spread narrower than 50 bps",
  },
  // Imbalance triggers - detect order flow
  {
    id_prefix: "prod_imbalance_bid",
    asset_id: "*",
    condition: { type: "IMBALANCE_BID", threshold: 0.6 },
    cooldown_ms: 15000,
    description: "Book imbalance >60% bid-heavy",
  },
  {
    id_prefix: "prod_imbalance_ask",
    asset_id: "*",
    condition: { type: "IMBALANCE_ASK", threshold: 0.6 },
    cooldown_ms: 15000,
    description: "Book imbalance >60% ask-heavy",
  },
  {
    id_prefix: "prod_imbalance_shift",
    asset_id: "*",
    condition: { type: "IMBALANCE_SHIFT", threshold: 0.4, window_ms: 30000 },
    cooldown_ms: 20000,
    description: "Imbalance shifted >40% in 30s",
  },
  // Size triggers - whale detection
  {
    id_prefix: "prod_size_spike_bid",
    asset_id: "*",
    condition: { type: "SIZE_SPIKE", threshold: 10000, side: "BID" },
    cooldown_ms: 20000,
    description: "Large bid size >$10k",
  },
  {
    id_prefix: "prod_size_spike_ask",
    asset_id: "*",
    condition: { type: "SIZE_SPIKE", threshold: 10000, side: "ASK" },
    cooldown_ms: 20000,
    description: "Large ask size >$10k",
  },
  {
    id_prefix: "prod_large_fill",
    asset_id: "*",
    condition: { type: "LARGE_FILL", threshold: 1000 },
    cooldown_ms: 15000,
    description: "Large fill >$1k detected",
  },
  // Price movement triggers
  {
    id_prefix: "prod_price_move",
    asset_id: "*",
    condition: { type: "PRICE_MOVE", threshold: 3, window_ms: 60000 },
    cooldown_ms: 30000,
    description: "Price moved >3% in 60s",
  },
  {
    id_prefix: "prod_mid_price_trend",
    asset_id: "*",
    condition: { type: "MID_PRICE_TREND", threshold: 3 },
    cooldown_ms: 30000,
    description: "3+ consecutive price moves",
  },
  // HFT/Market quality triggers
  {
    id_prefix: "prod_microprice_divergence",
    asset_id: "*",
    condition: { type: "MICROPRICE_DIVERGENCE", threshold: 50 },
    cooldown_ms: 20000,
    description: "Microprice diverged >50 bps from mid",
  },
  {
    id_prefix: "prod_quote_velocity",
    asset_id: "*",
    condition: { type: "QUOTE_VELOCITY", threshold: 3, window_ms: 5000 },
    cooldown_ms: 30000,
    description: "Quote velocity >3 updates/sec",
  },
  {
    id_prefix: "prod_stale_quote",
    asset_id: "*",
    condition: { type: "STALE_QUOTE", threshold: 60000 },
    cooldown_ms: 120000,
    description: "No update for 1 minute",
  },
];

/**
 * Delete all triggers from all shards. Use before re-initializing.
 */
app.post("/admin/delete-all-triggers", authMiddleware, async (c) => {
  const shardResults = await forEachShard<number>(
    c.env,
    async (stub) => {
      const listResp = await stub.fetch("http://do/triggers");
      const listData = (await listResp.json()) as { triggers: Array<{ id: string }> };
      let deleted = 0;

      for (const trigger of listData.triggers) {
        await stub.fetch("http://do/triggers/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger_id: trigger.id }),
        });
        deleted++;
      }
      return deleted;
    },
    { continueOnError: true }
  );

  const deletedCount = shardResults.reduce((sum, r) => sum + (r.result ?? 0), 0);
  const errors = shardResults.filter((r) => r.error).length;

  return c.json({ status: "complete", deleted: deletedCount, shard_errors: errors });
});

/**
 * Initialize production triggers on all shards.
 * Call this after deployment to set up real-time trigger events.
 * Idempotent - won't create duplicates if triggers already exist.
 */
app.post("/admin/init-triggers", authMiddleware, async (c) => {
  const results: Array<{ trigger: string; status: string; shards?: number; error?: string }> = [];

  for (const triggerDef of PRODUCTION_TRIGGERS) {
    // Register on all shards in parallel (wildcard triggers need to be everywhere)
    const shardResults = await Promise.all(
      Array.from({ length: SHARD_COUNT }, async (_, i) => {
        const stub = getOrderbookManagerStub(c.env, `shard-${i}`);
        try {
          const response = await stub.fetch("http://do/triggers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              asset_id: triggerDef.asset_id,
              condition: triggerDef.condition,
              webhook_url: "https://noop.webhook", // Required field, but events stream via SSE
              cooldown_ms: triggerDef.cooldown_ms,
              enabled: true,
              metadata: { production: "true", description: triggerDef.description },
            }),
          });
          return { ok: response.ok };
        } catch {
          return { ok: false };
        }
      })
    );

    const successCount = shardResults.filter((r) => r.ok).length;
    results.push({
      trigger: triggerDef.id_prefix,
      status: successCount > 0 ? "registered" : "failed",
      shards: successCount,
    });
  }

  const totalRegistered = results.filter((r) => r.status === "registered").length;

  return c.json({
    status: "complete",
    summary: {
      triggers_registered: totalRegistered,
      total_triggers: PRODUCTION_TRIGGERS.length,
      shards: SHARD_COUNT,
    },
    results,
  });
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
// Dashboard API Endpoints (Public - CORS enabled)
// ============================================================

// CORS middleware for dashboard API
const dashboardApi = new Hono<{ Bindings: Env }>();

dashboardApi.use("*", cors({
  origin: (origin) => origin || "*", // Allow the requesting origin for credentials
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-API-Key"],
  credentials: true,
}));

// Session cookie name
const SESSION_COOKIE = "dashboard_session";

/**
 * Parse cookies from request header
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...val] = c.trim().split("=");
      return [key, val.join("=")];
    })
  );
}

/**
 * Generate a signed session token using HMAC
 * Token format: timestamp.signature
 */
async function generateSessionToken(apiKey: string): Promise<string> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp));
  const signatureHex = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${timestamp}.${signatureHex}`;
}

/**
 * Validate a session token
 */
async function verifySessionToken(token: string, apiKey: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [timestamp, signature] = parts;
  const tokenAge = Date.now() - parseInt(timestamp, 10);

  // Token expires after 24 hours
  if (tokenAge > 24 * 60 * 60 * 1000) return false;

  // Verify signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = new Uint8Array(signature.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(timestamp));
}

/**
 * Auth endpoint - validates API key and sets session cookie
 * POST /api/v1/auth with X-API-Key header or { "api_key": "..." } body
 */
dashboardApi.post("/auth", async (c) => {
  const apiKey = c.req.header("X-API-Key") || (await c.req.json().catch(() => ({}))).api_key;

  if (!apiKey || apiKey !== c.env.VITE_DASHBOARD_API_KEY) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Generate signed session token (stateless - no storage needed)
  const sessionToken = await generateSessionToken(apiKey);

  // Set httpOnly cookie with SameSite=None for cross-origin SSE
  const cookie = `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=86400`;

  return c.json(
    { success: true, message: "Authenticated" },
    200,
    { "Set-Cookie": cookie }
  );
});

/**
 * Validate session from cookie (stateless verification)
 */
async function validateSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const cookies = parseCookies(c.req.header("Cookie"));
  const sessionToken = cookies[SESSION_COOKIE];

  if (!sessionToken) return false;

  return verifySessionToken(sessionToken, c.env.VITE_DASHBOARD_API_KEY);
}

// Top Activity Endpoint - Most active market by tick count
dashboardApi.get("/markets/top-activity", async (c) => {
  if (!c.env.CLICKHOUSE_URL) {
    return c.json({ error: "CLICKHOUSE_URL not configured" }, 503);
  }

  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
  };

  // Query top market with metadata using proper JSON extraction
  // Filters for: active markets only (end_date > now) AND activity in last 10 minutes
  const query = `
    WITH tokens AS (
      SELECT
        question,
        end_date,
        arrayJoin(JSONExtractArrayRaw(clob_token_ids)) as token
      FROM ${DB_CONFIG.DATABASE}.market_metadata
      WHERE end_date > now()
    )
    SELECT
      t.question,
      replaceAll(t.token, '"', '') as asset_id,
      b.condition_id,
      countMerge(b.tick_count_state) as tick_count
    FROM tokens t
    INNER JOIN ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m b ON replaceAll(t.token, '"', '') = b.asset_id
    WHERE b.minute >= now() - INTERVAL 10 MINUTE
    GROUP BY t.question, asset_id, b.condition_id
    ORDER BY tick_count DESC
    LIMIT 1
    FORMAT JSON
  `;

  try {
    const response = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`,
      { headers }
    );

    if (!response.ok) {
      const error = await response.text();
      return c.json({ error: "ClickHouse query failed", details: error }, 500);
    }

    const result = await response.json() as { data: Array<{ question: string; asset_id: string; condition_id: string; tick_count: number }> };

    if (result.data.length === 0) {
      return c.json({ data: null, timestamp: new Date().toISOString() });
    }

    const topMarket = result.data[0];

    return c.json({
      data: {
        asset_id: topMarket.asset_id,
        condition_id: topMarket.condition_id,
        tick_count: topMarket.tick_count,
        question: topMarket.question,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({ error: "Failed to query top activity", details: String(error) }, 500);
  }
});

// OHLC Endpoint - Candlestick data for charting
dashboardApi.get("/ohlc/:asset_id", async (c) => {
  const assetId = c.req.param("asset_id");
  const interval = c.req.query("interval") || "1m";
  const hours = parseInt(c.req.query("hours") || "24");

  if (!c.env.CLICKHOUSE_URL) {
    return c.json({ error: "CLICKHOUSE_URL not configured" }, 503);
  }

  const headers = {
    "X-ClickHouse-User": c.env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": c.env.CLICKHOUSE_TOKEN,
  };

  // For 1-minute intervals, use the 1m materialized view
  // For larger intervals, we'd aggregate from 1m bars
  // Filter by the hours parameter to only return recent data
  const query = interval === "1m"
    ? `
      SELECT
        toUnixTimestamp(minute) * 1000 as time,
        toFloat64((argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2) as open,
        toFloat64(greatest(maxMerge(high_bid_state), maxMerge(high_ask_state))) as high,
        toFloat64(least(minMerge(low_bid_state), minMerge(low_ask_state))) as low,
        toFloat64((argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2) as close,
        toUInt64(countMerge(tick_count_state)) as volume
      FROM ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m
      WHERE asset_id = '${assetId}'
        AND minute >= now() - INTERVAL ${hours} HOUR
      GROUP BY minute
      ORDER BY minute ASC
      FORMAT JSON
    `
    : `
      SELECT
        toUnixTimestamp(toStartOfFiveMinutes(minute)) * 1000 as time,
        toFloat64(argMin((argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2, minute)) as open,
        toFloat64(max(greatest(maxMerge(high_bid_state), maxMerge(high_ask_state)))) as high,
        toFloat64(min(least(minMerge(low_bid_state), minMerge(low_ask_state)))) as low,
        toFloat64(argMax((argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2, minute)) as close,
        toUInt64(sum(countMerge(tick_count_state))) as volume
      FROM ${DB_CONFIG.DATABASE}.mv_ob_bbo_1m
      WHERE asset_id = '${assetId}'
        AND minute >= now() - INTERVAL ${hours} HOUR
      GROUP BY toStartOfFiveMinutes(minute)
      ORDER BY time ASC
      FORMAT JSON
    `;

  try {
    const response = await fetch(
      `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`,
      { headers }
    );

    if (!response.ok) {
      const error = await response.text();
      return c.json({ error: "ClickHouse query failed", details: error }, 500);
    }

    const result = await response.json() as {
      data: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
    };

    return c.json({
      data: result.data,
      asset_id: assetId,
      interval,
      hours,
    });
  } catch (error) {
    return c.json({ error: "Failed to query OHLC", details: String(error) }, 500);
  }
});

// SSE Endpoint - Stream trigger events
// Uses cookie-based auth (call POST /auth first to get session cookie)
dashboardApi.get("/triggers/events/sse", async (c) => {
  if (!(await validateSession(c))) {
    return c.json({ error: "Unauthorized - please authenticate first via POST /api/v1/auth" }, 401);
  }

  // Route to the global TriggerEventBuffer DO (with location hint for low latency)
  const stub = getTriggerEventBufferStub(c.env);

  return stub.fetch(new Request("https://do/sse", {
    headers: c.req.raw.headers,
  }));
});

// Trigger event buffer status
dashboardApi.get("/triggers/events/status", async (c) => {
  if (!(await validateSession(c))) {
    return c.json({ error: "Unauthorized - please authenticate first via POST /api/v1/auth" }, 401);
  }

  const stub = getTriggerEventBufferStub(c.env);
  const response = await stub.fetch(new Request("https://do/status"));
  return response;
});

// Get buffered trigger events for validation/debugging
dashboardApi.get("/triggers/events", async (c) => {
  if (!(await validateSession(c))) {
    return c.json({ error: "Unauthorized - please authenticate first via POST /api/v1/auth" }, 401);
  }

  const stub = getTriggerEventBufferStub(c.env);
  const limit = c.req.query("limit") || "20";
  const type = c.req.query("type") || "";
  const url = `https://do/events?limit=${limit}${type ? `&type=${type}` : ""}`;

  const response = await stub.fetch(new Request(url));
  return response;
});

// Mount dashboard API under /api/v1
app.route("/api/v1", dashboardApi);

// Export Durable Objects
export { OrderbookManager, TriggerEventBuffer };

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
    case "dead-letter-queue":
      await deadLetterConsumer(batch as MessageBatch<DeadLetterMessage>, env);
      break;
  }
}

/**
 * Check if any markets are subscribed across all shards
 */
async function getTotalSubscriptions(env: Env): Promise<number> {
  const shardResults = await forEachShard<number>(
    env,
    async (stub) => {
      const resp = await stub.fetch("http://do/status");
      const data = (await resp.json()) as { total_assets?: number };
      return data.total_assets ?? 0;
    },
    { continueOnError: true }
  );
  return shardResults.reduce((sum, r) => sum + (r.result ?? 0), 0);
}

/**
 * Bootstrap all active markets from Gamma API
 */
async function bootstrapActiveMarkets(env: Env): Promise<{ subscribed: number; errors: number }> {
  console.log("[Bootstrap] Fetching all active markets from Gamma API");

  const response = await fetch(
    `${env.GAMMA_API_URL}/markets?active=true&closed=false&enableOrderBook=true&limit=1000`,
    { headers: { Accept: "application/json" } }
  );

  if (!response.ok) {
    console.error("[Bootstrap] Gamma API error:", response.status);
    return { subscribed: 0, errors: 1 };
  }

  interface GammaMarket {
    conditionId: string;
    clobTokenIds: string;
    orderPriceMinTickSize: number;
    negRisk: boolean;
    orderMinSize: number;
  }

  const markets = (await response.json()) as GammaMarket[];
  console.log(`[Bootstrap] Found ${markets.length} active markets`);

  let subscribed = 0;
  let errors = 0;

  for (const market of markets) {
    let tokenIds: string[] = [];
    try {
      tokenIds = JSON.parse(market.clobTokenIds);
    } catch {
      tokenIds = [market.clobTokenIds];
    }

    const shardId = getShardForMarket(market.conditionId);
    const stub = getOrderbookManagerStub(env, shardId);

    try {
      await stub.fetch("http://do/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          condition_id: market.conditionId,
          token_ids: tokenIds,
          tick_size: market.orderPriceMinTickSize,
          neg_risk: market.negRisk,
          order_min_size: market.orderMinSize,
          market_source: "polymarket",
        }),
      });
      subscribed++;
    } catch {
      errors++;
    }
  }

  return { subscribed, errors };
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

    // AUTOMATIC BOOTSTRAP: Check if we have any subscriptions
    // On fresh deployment, no markets are subscribed - this fixes the gap
    const totalSubscriptions = await getTotalSubscriptions(env);
    if (totalSubscriptions === 0) {
      console.log("[Scheduled] No markets subscribed - running automatic bootstrap");
      ctx.waitUntil(
        bootstrapActiveMarkets(env).then((result) => {
          console.log(`[Scheduled] Bootstrap complete: ${result.subscribed} subscribed, ${result.errors} errors`);
        })
      );
      return; // Skip lifecycle check on bootstrap run
    }

    const lifecycle = new MarketLifecycleService(env);

    // Load webhooks from KV
    const webhooks = await loadLifecycleWebhooks(env);
    for (const wh of webhooks) {
      lifecycle.registerWebhook(wh);
    }

    ctx.waitUntil(
      lifecycle.runCheck().then(async (results) => {
        console.log(
          `[Scheduled] Lifecycle check complete: ${results.resolutions} resolutions, ${results.new_markets} new markets, ${results.metadata_synced} metadata synced`
        );

        // Subscribe new markets to OrderbookManager DOs for real-time monitoring
        if (results.newMarketEvents.length > 0) {
          console.log(`[Scheduled] Subscribing ${results.newMarketEvents.length} new markets`);
          const subscription = await subscribeNewMarkets(env, results.newMarketEvents);
          console.log(`[Scheduled] Subscribed ${subscription.subscribed} markets, ${subscription.errors.length} errors`);
          subscription.errors.forEach((err) => console.error(`[Scheduled] ${err}`));
        }

        // Clean up resolved markets using coordinated cleanup service
        if (results.resolutionEvents.length > 0) {
          const cleanupService = new MarketCleanupService(env, getShardForMarket);

          for (const event of results.resolutionEvents) {
            try {
              await cleanupService.cleanupMarket(event.condition_id, event.token_ids);
            } catch (err) {
              console.error(`[Scheduled] Failed to cleanup market ${event.condition_id}:`, err);
            }
          }
        }
      })
    );
  }
}

export default {
  fetch: app.fetch,
  queue: queueHandler,
  scheduled: scheduledHandler,
};
