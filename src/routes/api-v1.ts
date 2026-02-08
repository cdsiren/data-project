// src/routes/api-v1.ts
// OpenAPI-enabled API routes with Zod validation

import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import type { Env } from "../types";
import { DB_CONFIG } from "../config/database";
import { rateLimiter } from "../middleware/rate-limiter";
import {
  MarketListQuerySchema,
  MarketSearchQuerySchema,
  AssetIdParamSchema,
} from "../schemas/markets";
import {
  ClickHouseError,
  MarketNotFoundError,
  AssetNotSubscribedError,
  ConfigurationError,
  InvalidFieldError,
} from "../errors";
import {
  escapeClickHouseString,
  quoteClickHouseString,
  validateMarketSource,
  isValidAssetId,
  parseJSONEachRow,
  fetchWithTimeout,
  buildWhereClause,
} from "../utils/clickhouse";

// ============================================================
// Constants
// ============================================================

const QUERY_TIMEOUT_MS = 10000; // 10 seconds for data queries
const SHARD_COUNT = 25;

// ============================================================
// OpenAPI App Setup
// ============================================================

export const apiV1 = new Hono<{ Bindings: Env }>();

// CORS middleware
apiV1.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Key"],
    credentials: true,
  })
);

// Rate limiting (skip for docs/spec endpoints)
apiV1.use(
  "*",
  rateLimiter({
    skipPaths: ["/openapi.json", "/docs"],
  })
);

// ============================================================
// OpenAPI Specification
// ============================================================

const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Market Data API",
    version: "1.0.0",
    description: `High-performance market data API for prediction markets and DEXs.

## Features
- Real-time orderbook data via WebSocket/SSE
- OHLC candlestick data with multiple intervals
- Low-latency trigger system for price alerts
- Historical data export for backtesting

## Authentication
All endpoints require an API key via the \`X-API-Key\` header.

## Rate Limits
| Tier | Data (req/min) | Admin (req/min) |
|------|----------------|-----------------|
| Free | 60 | 15 |
| Pro | 120 | 30 |
| Enterprise | 600 | 120 |`,
    contact: {
      name: "API Support",
      email: "support@example.com",
    },
    license: {
      name: "MIT",
    },
  },
  servers: [
    {
      url: "https://api.example.com/api/v1",
      description: "Production",
    },
    {
      url: "http://localhost:8787/api/v1",
      description: "Local development",
    },
  ],
  tags: [
    { name: "Markets", description: "Market metadata and search" },
    { name: "Orderbook", description: "Real-time orderbook data" },
    { name: "Triggers", description: "Price alert triggers" },
    { name: "Backtest", description: "Historical data export" },
  ],
  paths: {
    "/markets": {
      get: {
        tags: ["Markets"],
        summary: "List available markets",
        description:
          "Returns a paginated list of markets with metadata and recent activity stats.",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 100, maximum: 1000 },
          },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          {
            name: "market_source",
            in: "query",
            schema: { type: "string", enum: ["polymarket"] },
          },
          { name: "active", in: "query", schema: { type: "boolean", default: true } },
        ],
        responses: {
          "200": {
            description: "List of markets",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/MarketListItem" },
                    },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/markets/search": {
      get: {
        tags: ["Markets"],
        summary: "Search markets by question text",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 2 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20, maximum: 100 },
          },
        ],
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/MarketListItem" },
                    },
                    query: { type: "string" },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/markets/{asset_id}": {
      get: {
        tags: ["Markets"],
        summary: "Get market details",
        parameters: [
          {
            name: "asset_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Market details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MarketDetail" },
              },
            },
          },
          "404": { description: "Market not found" },
        },
      },
    },
    "/markets/{asset_id}/orderbook": {
      get: {
        tags: ["Orderbook"],
        summary: "Get current orderbook",
        description:
          "Returns the current orderbook state from the Durable Object (sub-10ms latency).",
        parameters: [
          {
            name: "asset_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Orderbook snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Orderbook" },
              },
            },
          },
          "404": { description: "Asset not subscribed" },
        },
      },
    },
  },
  components: {
    schemas: {
      MarketListItem: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          condition_id: { type: "string" },
          question: { type: "string" },
          market_source: {
            type: "string",
            enum: ["polymarket"],
          },
          market_type: {
            type: "string",
            enum: ["prediction"],
          },
          category: { type: "string", nullable: true },
          neg_risk: { type: "boolean" },
          end_date: { type: "string", format: "date-time", nullable: true },
          tick_count: { type: "integer" },
          last_tick: { type: "string", format: "date-time", nullable: true },
        },
      },
      MarketDetail: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          condition_id: { type: "string" },
          question: { type: "string" },
          description: { type: "string", nullable: true },
          market_source: { type: "string" },
          market_type: { type: "string" },
          category: { type: "string", nullable: true },
          neg_risk: { type: "boolean" },
          end_date: { type: "string", format: "date-time", nullable: true },
          current_price: {
            type: "object",
            nullable: true,
            properties: {
              bid: { type: "number" },
              ask: { type: "number" },
              mid: { type: "number" },
              spread_bps: { type: "number" },
            },
          },
          stats_24h: {
            type: "object",
            nullable: true,
            properties: {
              tick_count: { type: "integer" },
              high: { type: "number" },
              low: { type: "number" },
            },
          },
        },
      },
      Orderbook: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          bids: { type: "array", items: { $ref: "#/components/schemas/PriceLevel" } },
          asks: { type: "array", items: { $ref: "#/components/schemas/PriceLevel" } },
          spread_bps: { type: "number", nullable: true },
        },
      },
      PriceLevel: {
        type: "object",
        properties: {
          price: { type: "number" },
          size: { type: "number" },
        },
      },
      Pagination: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          offset: { type: "integer" },
          total: { type: "integer" },
          has_more: { type: "boolean" },
        },
      },
    },
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
};

// OpenAPI JSON endpoint
apiV1.get("/openapi.json", (c) => {
  return c.json(openApiSpec);
});

// Scalar API Reference UI
apiV1.get("/docs", (c) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Market Data API - Documentation</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/api/v1/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return c.html(html);
});

// ============================================================
// Helper: Ensure ClickHouse is configured
// ============================================================

function requireClickHouse(env: Env): void {
  if (!env.CLICKHOUSE_URL) {
    throw new ConfigurationError("CLICKHOUSE_URL");
  }
}

function getClickHouseHeaders(env: Env): Record<string, string> {
  return {
    "X-ClickHouse-User": env.CLICKHOUSE_USER,
    "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
  };
}

// ============================================================
// Helper: Calculate shard ID
// ============================================================

function getShardId(conditionId: string): string {
  const hash = Array.from(conditionId).reduce(
    (acc, char, idx) => ((acc << 5) - acc) + char.charCodeAt(0) + idx,
    0
  );
  return `shard-${Math.abs(hash) % SHARD_COUNT}`;
}

// ============================================================
// Market Routes
// ============================================================

// GET /markets - List markets with Zod validation
apiV1.get(
  "/markets",
  zValidator("query", MarketListQuerySchema, (result, c) => {
    if (!result.success) {
      throw new InvalidFieldError(
        "query",
        result.error.issues,
        "valid query parameters"
      );
    }
  }),
  async (c) => {
    requireClickHouse(c.env);

    const { market_source, active, limit, offset } = c.req.valid("query");
    const headers = getClickHouseHeaders(c.env);

    // Build WHERE clauses with proper escaping
    const whereConditions: string[] = [];

    if (market_source) {
      const validatedSource = validateMarketSource(market_source);
      if (validatedSource) {
        whereConditions.push(`m.market_source = ${quoteClickHouseString(validatedSource)}`);
      } else {
        throw new InvalidFieldError(
          "market_source",
          market_source,
          "polymarket"
        );
      }
    }

    if (active) {
      whereConditions.push("mm.end_date > now()");
    }

    const whereClause = buildWhereClause(whereConditions);

    const query = `
      WITH market_activity AS (
        SELECT
          asset_id,
          market_source,
          market_type,
          count() as tick_count,
          max(source_ts) as last_tick
        FROM ${DB_CONFIG.DATABASE}.ob_bbo
        WHERE source_ts >= now() - INTERVAL 24 HOUR
        GROUP BY asset_id, market_source, market_type
      ),
      tokens AS (
        SELECT
          id,
          question,
          condition_id,
          slug,
          end_date,
          neg_risk,
          category,
          arrayJoin(JSONExtractArrayRaw(clob_token_ids)) as token
        FROM ${DB_CONFIG.DATABASE}.market_metadata
      )
      SELECT
        replaceAll(t.token, '"', '') as asset_id,
        t.condition_id,
        t.question,
        coalesce(m.market_source, 'polymarket') as market_source,
        coalesce(m.market_type, 'prediction') as market_type,
        t.category,
        t.neg_risk,
        t.end_date,
        coalesce(m.tick_count, 0) as tick_count,
        m.last_tick
      FROM tokens t
      LEFT JOIN market_activity m ON replaceAll(t.token, '"', '') = m.asset_id
      ${whereClause}
      ORDER BY tick_count DESC, t.end_date ASC
      LIMIT ${limit}
      OFFSET ${offset}
      FORMAT JSONEachRow
    `;

    const response = await fetchWithTimeout(
      `${c.env.CLICKHOUSE_URL}/?async_insert=0`,
      {
        method: "POST",
        headers,
        body: query,
      },
      QUERY_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[markets] ClickHouse error:", errorText);
      throw new ClickHouseError("Database query failed", query, errorText);
    }

    const text = await response.text();
    const markets = parseJSONEachRow(text, (m) => ({
      ...m,
      neg_risk: Boolean(m.neg_risk),
    }));

    // Get total count for pagination
    const countQuery = `
      WITH tokens AS (
        SELECT
          id,
          end_date,
          arrayJoin(JSONExtractArrayRaw(clob_token_ids)) as token
        FROM ${DB_CONFIG.DATABASE}.market_metadata
        ${active ? "WHERE end_date > now()" : ""}
      )
      SELECT count() as total FROM tokens
    `;

    const countResponse = await fetchWithTimeout(
      `${c.env.CLICKHOUSE_URL}/?async_insert=0`,
      {
        method: "POST",
        headers,
        body: countQuery,
      },
      QUERY_TIMEOUT_MS
    );

    let total = markets.length;
    if (countResponse.ok) {
      const countText = await countResponse.text();
      const match = countText.match(/(\d+)/);
      if (match) {
        total = parseInt(match[1]);
      }
    }

    return c.json({
      data: markets,
      pagination: {
        limit,
        offset,
        total,
        has_more: offset + markets.length < total,
      },
      timestamp: new Date().toISOString(),
    });
  }
);

// GET /markets/search - Search markets with Zod validation
apiV1.get(
  "/markets/search",
  zValidator("query", MarketSearchQuerySchema, (result, c) => {
    if (!result.success) {
      throw new InvalidFieldError(
        "q",
        result.error.issues,
        "search query with minimum 2 characters"
      );
    }
  }),
  async (c) => {
    requireClickHouse(c.env);

    const { q, limit } = c.req.valid("query");
    const headers = getClickHouseHeaders(c.env);

    // Escape the search query for safe SQL inclusion
    const escapedQuery = escapeClickHouseString(q.toLowerCase());

    const query = `
      WITH tokens AS (
        SELECT
          id,
          question,
          condition_id,
          end_date,
          neg_risk,
          category,
          arrayJoin(JSONExtractArrayRaw(clob_token_ids)) as token
        FROM ${DB_CONFIG.DATABASE}.market_metadata
        WHERE position(lower(question), '${escapedQuery}') > 0
          AND end_date > now()
      )
      SELECT
        replaceAll(t.token, '"', '') as asset_id,
        t.condition_id,
        t.question,
        'polymarket' as market_source,
        'prediction' as market_type,
        t.category,
        t.neg_risk,
        t.end_date,
        0 as tick_count,
        null as last_tick
      FROM tokens t
      LIMIT ${limit}
      FORMAT JSONEachRow
    `;

    const response = await fetchWithTimeout(
      `${c.env.CLICKHOUSE_URL}/?async_insert=0`,
      {
        method: "POST",
        headers,
        body: query,
      },
      QUERY_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[markets/search] ClickHouse error:", errorText);
      throw new ClickHouseError("Search query failed", query, errorText);
    }

    const text = await response.text();
    const markets = parseJSONEachRow(text, (m) => ({
      ...m,
      neg_risk: Boolean(m.neg_risk),
    }));

    return c.json({
      data: markets,
      query: q,
      total: markets.length,
    });
  }
);

// GET /markets/top-activity - Most active market by tick count
// Must be defined BEFORE /markets/:asset_id to avoid route collision
apiV1.get("/markets/top-activity", async (c) => {
  requireClickHouse(c.env);

  const headers = getClickHouseHeaders(c.env);

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
      count() as tick_count
    FROM tokens t
    INNER JOIN ${DB_CONFIG.DATABASE}.ob_bbo b ON replaceAll(t.token, '"', '') = b.asset_id
    WHERE b.source_ts >= now() - INTERVAL 10 MINUTE
    GROUP BY t.question, asset_id, b.condition_id
    ORDER BY tick_count DESC
    LIMIT 1
    FORMAT JSON
  `;

  const response = await fetchWithTimeout(
    `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`,
    { headers },
    QUERY_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new ClickHouseError("Top activity query failed", query, errorText);
  }

  const result = (await response.json()) as {
    data: Array<{
      question: string;
      asset_id: string;
      condition_id: string;
      tick_count: number;
    }>;
  };

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
});

// GET /markets/:asset_id - Get market details with Zod validation
apiV1.get(
  "/markets/:asset_id",
  zValidator("param", AssetIdParamSchema, (result, c) => {
    if (!result.success) {
      throw new InvalidFieldError("asset_id", result.error.issues, "valid asset ID");
    }
  }),
  async (c) => {
    requireClickHouse(c.env);

    const { asset_id } = c.req.valid("param");
    const headers = getClickHouseHeaders(c.env);

    // Validate asset ID format for extra safety
    if (!isValidAssetId(asset_id)) {
      throw new InvalidFieldError(
        "asset_id",
        asset_id,
        "hexadecimal string (16-128 characters)"
      );
    }

    const escapedAssetId = escapeClickHouseString(asset_id);

    // Get market metadata
    const metadataQuery = `
      SELECT
        id,
        question,
        description,
        condition_id,
        category,
        neg_risk,
        end_date,
        clob_token_ids
      FROM ${DB_CONFIG.DATABASE}.market_metadata
      WHERE position(clob_token_ids, '${escapedAssetId}') > 0
      LIMIT 1
      FORMAT JSON
    `;

    // Get current BBO (PREWHERE for primary key filter optimization)
    const bboQuery = `
      SELECT
        best_bid,
        best_ask,
        spread_bps
      FROM ${DB_CONFIG.DATABASE}.ob_bbo
      PREWHERE asset_id = '${escapedAssetId}'
      ORDER BY source_ts DESC
      LIMIT 1
      FORMAT JSON
    `;

    // Get 24h stats (PREWHERE for primary key filter optimization)
    const statsQuery = `
      SELECT
        count() as tick_count,
        max(best_bid) as high,
        min(best_bid) as low
      FROM ${DB_CONFIG.DATABASE}.ob_bbo
      PREWHERE asset_id = '${escapedAssetId}'
      WHERE source_ts >= now() - INTERVAL 24 HOUR
      FORMAT JSON
    `;

    const [metadataRes, bboRes, statsRes] = await Promise.all([
      fetchWithTimeout(
        `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(metadataQuery)}`,
        { headers },
        QUERY_TIMEOUT_MS
      ),
      fetchWithTimeout(
        `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(bboQuery)}`,
        { headers },
        QUERY_TIMEOUT_MS
      ),
      fetchWithTimeout(
        `${c.env.CLICKHOUSE_URL}/?query=${encodeURIComponent(statsQuery)}`,
        { headers },
        QUERY_TIMEOUT_MS
      ),
    ]);

    if (!metadataRes.ok) {
      const errorText = await metadataRes.text();
      throw new ClickHouseError("Failed to fetch market metadata", metadataQuery, errorText);
    }

    const metadataResult = (await metadataRes.json()) as {
      data: Array<Record<string, unknown>>;
    };

    if (metadataResult.data.length === 0) {
      throw new MarketNotFoundError(asset_id);
    }

    const metadata = metadataResult.data[0];

    // Parse BBO
    let currentPrice = null;
    if (bboRes.ok) {
      const bboResult = (await bboRes.json()) as {
        data: Array<{
          best_bid: number;
          best_ask: number;
          spread_bps: number;
        }>;
      };
      if (bboResult.data.length > 0) {
        const bbo = bboResult.data[0];
        currentPrice = {
          bid: Number(bbo.best_bid),
          ask: Number(bbo.best_ask),
          spread_bps: Number(bbo.spread_bps),
        };
      }
    }

    // Parse stats
    let stats24h = null;
    if (statsRes.ok) {
      const statsResult = (await statsRes.json()) as {
        data: Array<{ tick_count: number; high: number; low: number }>;
      };
      if (statsResult.data.length > 0 && statsResult.data[0].tick_count > 0) {
        const stats = statsResult.data[0];
        stats24h = {
          tick_count: Number(stats.tick_count),
          high: Number(stats.high),
          low: Number(stats.low),
        };
      }
    }

    return c.json({
      asset_id,
      condition_id: metadata.condition_id,
      question: metadata.question,
      description: metadata.description || null,
      market_source: "polymarket",
      market_type: "prediction",
      category: metadata.category || null,
      neg_risk: Boolean(metadata.neg_risk),
      end_date: metadata.end_date || null,
      current_price: currentPrice,
      stats_24h: stats24h,
    });
  }
);

// GET /markets/:asset_id/orderbook - Get current orderbook
apiV1.get(
  "/markets/:asset_id/orderbook",
  zValidator("param", AssetIdParamSchema, (result, c) => {
    if (!result.success) {
      throw new InvalidFieldError("asset_id", result.error.issues, "valid asset ID");
    }
  }),
  async (c) => {
    const { asset_id } = c.req.valid("param");

    // Look up condition_id from cache to route to correct shard
    const conditionIdKey = `asset_condition:${asset_id}`;
    const conditionId = await c.env.MARKET_CACHE.get(conditionIdKey);

    if (!conditionId) {
      throw new AssetNotSubscribedError(
        asset_id,
        "Run /lifecycle/check to sync market metadata"
      );
    }

    // Get shard for this market
    const shardId = getShardId(conditionId);

    // Fetch orderbook from DO
    const doId = c.env.ORDERBOOK_MANAGER.idFromName(shardId);
    const stub = c.env.ORDERBOOK_MANAGER.get(doId);

    const response = await stub.fetch(`http://do/orderbook/${asset_id}`);

    if (!response.ok) {
      const error = await response.text();
      throw new AssetNotSubscribedError(asset_id, error);
    }

    const data = (await response.json()) as {
      asset_id: string;
      bids: Array<{ price: number; size: number }>;
      asks: Array<{ price: number; size: number }>;
      timestamp: string;
    };

    // Calculate spread and mid price with null safety
    const bestBid = data.bids[0]?.price;
    const bestAsk = data.asks[0]?.price;

    // If either side is missing, we can't calculate valid spread
    if (bestBid === undefined || bestAsk === undefined) {
      return c.json({
        asset_id: data.asset_id,
        timestamp: data.timestamp,
        bids: data.bids,
        asks: data.asks,
        spread_bps: null,
      });
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    return c.json({
      asset_id: data.asset_id,
      timestamp: data.timestamp,
      bids: data.bids,
      asks: data.asks,
      spread_bps: Math.round(spreadBps),
    });
  }
);

export default apiV1;
