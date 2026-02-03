# Polymarket Data Enrichment Pipeline

A Cloudflare Workers project for real-time orderbook monitoring, trade data ingestion, and ultra-low-latency trigger evaluation for Polymarket prediction markets.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Directory Structure](#directory-structure)
- [Key Components](#key-components)
- [Data Flow](#data-flow)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Documentation](#api-documentation)
- [API Reference](#api-reference)
- [Rate Limiting](#rate-limiting)
- [Trigger System](#trigger-system)
- [Database Schema](#database-schema)
- [Monitoring](#monitoring)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SYSTEM ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Polymarket WebSocket ──► OrderbookManager DO (25 shards)                  │
│                                    │                                        │
│                    ┌───────────────┼───────────────┐                        │
│                    │               │               │                        │
│                    ▼               ▼               ▼                        │
│            Trigger Eval     Queue Publish    Local State                    │
│              (<10ms)              │          (Orderbooks)                   │
│                    │               │                                        │
│                    ▼               ▼                                        │
│         TriggerEventBuffer   Cloudflare Queues                              │
│            (SSE Stream)           │                                         │
│                    │               ▼                                        │
│                    ▼          Queue Consumers                               │
│              Dashboard            │                                         │
│                                   ▼                                         │
│                              ClickHouse                                     │
│                           (Time-series DB)                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| **OrderbookManager** | Real-time WebSocket management, trigger evaluation | Durable Object (25 shards) |
| **TriggerEventBuffer** | SSE broadcasting to dashboard clients | Durable Object (1 global) |
| **Queue Consumers** | Async data persistence to ClickHouse | Cloudflare Queues |
| **Market Adapters** | Multi-market normalization (currently Polymarket) | Adapter pattern |
| **ClickHouse** | Time-series storage for orderbooks, trades | External service |

### Scaling

- **25 shards** × 450 assets/shard = **~11,250 concurrent assets**
- Sub-100ms WebSocket latency with location hints
- Batch processing: 100 messages per queue consumer

---

## Directory Structure

```
├── src/
│   ├── index.ts                    # Main worker entry point (Hono server)
│   ├── errors.ts                   # Custom error classes
│   ├── adapters/                   # Market connectors
│   │   ├── base-connector.ts       # Interface for multi-market support
│   │   ├── registry.ts             # Adapter factory
│   │   └── polymarket/             # Polymarket WebSocket adapter
│   ├── config/
│   │   └── database.ts             # Centralized DB & market config
│   ├── consumers/                  # Queue message processors
│   │   ├── snapshot-consumer.ts    # BBO tick persistence
│   │   ├── trade-tick-consumer.ts  # Trade execution data
│   │   ├── level-change-consumer.ts # Order flow deltas
│   │   ├── full-l2-snapshot-consumer.ts # Full depth snapshots
│   │   ├── gap-backfill-consumer.ts # Gap recovery
│   │   └── dead-letter-consumer.ts # Failed message handler
│   ├── core/
│   │   ├── orderbook.ts            # Orderbook data types
│   │   ├── triggers.ts             # Trigger definitions & events
│   │   └── enums.ts                # Market enums
│   ├── durable-objects/
│   │   ├── orderbook-manager.ts    # WebSocket + trigger evaluation
│   │   └── trigger-event-buffer.ts # SSE event broadcasting
│   ├── middleware/
│   │   └── rate-limiter.ts         # Tiered rate limiting
│   ├── routes/
│   │   ├── api-v1.ts               # OpenAPI-enabled market data API
│   │   └── backtest.ts             # Historical data export API
│   ├── schemas/                    # Zod validation schemas
│   │   ├── common.ts               # Shared types (UserTier, etc.)
│   │   ├── markets.ts              # Market query schemas
│   │   └── ohlc.ts                 # OHLC query schemas
│   ├── services/
│   │   ├── market-lifecycle.ts     # Market resolution detection
│   │   ├── market-cache.ts         # KV cache utilities
│   │   ├── clickhouse-client.ts    # ClickHouse HTTP wrapper
│   │   ├── clickhouse-orderbook.ts # Orderbook-specific queries
│   │   ├── hash-chain.ts           # Gap detection via hashing
│   │   ├── webhook-signer.ts       # HMAC webhook signing
│   │   └── trigger-evaluator/      # Trigger condition logic
│   ├── types/
│   │   ├── types.ts                # Global TypeScript types
│   │   └── orderbook.ts            # Orderbook message types
│   └── utils/
│       ├── clickhouse.ts           # ClickHouse query utilities
│       ├── datetime.ts             # Timestamp utilities
│       └── ring-buffer.ts          # Latency tracking
├── schema/
│   ├── orderbook_tables.sql        # ClickHouse DDL
│   └── CLICKHOUSE_SCHEMA.md        # Schema documentation
├── app/                            # React dashboard (monorepo)
│   ├── src/
│   │   ├── components/             # React components
│   │   │   ├── layout/             # Header, Footer
│   │   │   ├── triggers/           # Trigger table & details
│   │   │   ├── charts/             # Market charts
│   │   │   └── metrics/            # Performance metrics
│   │   ├── hooks/                  # React hooks
│   │   ├── lib/                    # API client & utilities
│   │   └── types/                  # Frontend types
│   └── package.json                # React app dependencies
├── wrangler.toml                   # Cloudflare Workers config
├── package.json                    # Dependencies & scripts
└── tsconfig.json                   # TypeScript config
```

---

## Key Components

### Durable Objects

**OrderbookManager (25 shards)**
- Maintains persistent WebSocket connections to Polymarket
- Processes orderbook updates in real-time
- Evaluates triggers with <10ms latency
- Manages local orderbook state per asset
- Publishes events to queues and TriggerEventBuffer

**TriggerEventBuffer (1 global)**
- Maintains SSE connections from dashboard clients
- Buffers last 100 trigger events for replay
- Real-time event broadcasting

### Queue Consumers

| Queue | Consumer | Purpose | TTL |
|-------|----------|---------|-----|
| `orderbook-snapshot-queue` | snapshotConsumer | BBO tick data | 90 days |
| `trade-tick-queue` | tradeTickConsumer | Trade executions | 90 days |
| `level-change-queue` | levelChangeConsumer | Order flow | 30 days |
| `full-l2-queue` | fullL2SnapshotConsumer | Full depth | 90 days |
| `gap-backfill-queue` | gapBackfillConsumer | Gap recovery | - |
| `dead-letter-queue` | deadLetterConsumer | Failed messages | 30 days |

### Services

- **MarketLifecycleService**: Polls Gamma API for resolutions and new markets
- **ClickHouseOrderbookClient**: Batch inserts with retry logic
- **TriggerEvaluator**: Evaluates 16+ trigger condition types
- **HashChainValidator**: Detects data gaps via hash chain

---

## Data Flow

```
Polymarket WebSocket
        │
        ▼
┌───────────────────────────────────────┐
│      OrderbookManager DO              │
│  ┌─────────────────────────────────┐  │
│  │ 1. Parse WebSocket message      │  │
│  │ 2. Normalize via adapter        │  │
│  │ 3. Update local orderbook       │  │
│  │ 4. Validate hash chain          │  │
│  │ 5. Evaluate triggers (<10ms)    │  │
│  │ 6. Publish to queues            │  │
│  └─────────────────────────────────┘  │
└───────────────────────────────────────┘
        │
        ├──► TriggerEventBuffer ──► Dashboard (SSE)
        │
        └──► Cloudflare Queues
                    │
                    ▼
            Queue Consumers
                    │
                    ▼
              ClickHouse
         ┌──────────────────┐
         │ ob_bbo           │ BBO ticks
         │ ob_snapshots     │ Full L2 depth
         │ trade_ticks      │ Executions
         │ ob_level_changes │ Order flow
         │ market_metadata  │ Market info
         └──────────────────┘
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- Cloudflare account with Workers, KV, Queues, and Durable Objects enabled
- ClickHouse instance (cloud or self-hosted)

### 1. Clone and Install

```bash
git clone <repository-url>
cd data-project
pnpm install
```

### 2. Create Cloudflare Resources

```bash
# Create KV namespaces
wrangler kv:namespace create MARKET_CACHE
wrangler kv:namespace create HASH_CHAIN_CACHE

# Create queues
wrangler queues create orderbook-snapshot-queue
wrangler queues create trade-tick-queue
wrangler queues create level-change-queue
wrangler queues create full-l2-queue
wrangler queues create gap-backfill-queue
wrangler queues create dead-letter-queue
```

### 3. Update wrangler.toml

Update the KV namespace IDs in `wrangler.toml` with the IDs from step 2:

```toml
[[kv_namespaces]]
binding = "MARKET_CACHE"
id = "YOUR_MARKET_CACHE_ID"

[[kv_namespaces]]
binding = "HASH_CHAIN_CACHE"
id = "YOUR_HASH_CHAIN_CACHE_ID"
```

### 4. Set Secrets

```bash
# ClickHouse credentials
wrangler secret put CLICKHOUSE_URL
# Enter: https://your-instance.clickhouse.cloud:8443

wrangler secret put CLICKHOUSE_USER
# Enter: default (or your username)

wrangler secret put CLICKHOUSE_TOKEN
# Enter: your-clickhouse-password

# Dashboard API key (optional)
wrangler secret put VITE_DASHBOARD_API_KEY
# Enter: your-secret-api-key
```

### 5. Create ClickHouse Tables

Run the schema migration via the API after deployment, or manually:

```bash
# Via ClickHouse client
clickhouse-client --host your-host --secure --password \
  --query "$(cat schema/orderbook_tables.sql)"

# Or via the deployed worker
curl -X POST https://your-worker.workers.dev/admin/migrate
```

### 6. Deploy

```bash
# Deploy to Cloudflare
pnpm run deploy

# Or for local development
pnpm run dev
```

### 7. Initialize Markets

```bash
# Bootstrap all active Polymarket markets
curl -X POST https://your-worker.workers.dev/admin/bootstrap-markets \
  -H "X-API-Key: your-api-key"

# Verify subscriptions
curl https://your-worker.workers.dev/health/subscriptions
```

### 8. (Optional) Register Production Triggers

```bash
curl -X POST https://your-worker.workers.dev/admin/init-triggers \
  -H "X-API-Key: your-api-key"
```

---

## Configuration

### Environment Variables (wrangler.toml)

```toml
[vars]
GAMMA_API_URL = "https://gamma-api.polymarket.com"
CLOB_WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
SNAPSHOT_INTERVAL_MS = "60000"
```

### Multi-Market Configuration

Markets are configured via the `MARKETS_CONFIG` JSON variable:

```toml
MARKETS_CONFIG = '''[
  {
    "market_source": "polymarket",
    "enabled": true,
    "ws_url": "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    "adapter_class": "PolymarketConnector",
    "location_hint": "weur",
    "config": {
      "max_instruments_per_ws": 500,
      "reconnect_delay_ms": 1000,
      "max_reconnect_delay_ms": 30000
    }
  }
]'''
```

### Cron Jobs

Defined in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *", "2 * * * *"]
```

| Schedule | Purpose |
|----------|---------|
| `*/5 * * * *` | Market lifecycle check (resolutions, new markets) |
| `2 * * * *` | Full market metadata refresh |

---

## API Documentation

Interactive API documentation is available when the worker is running:

- **OpenAPI Spec**: `GET /api/v1/openapi.json` - OpenAPI 3.1.0 specification
- **Interactive Docs**: `GET /api/v1/docs` - Scalar UI for exploring and testing endpoints

Example:
```bash
# View interactive documentation
open http://localhost:8787/api/v1/docs

# Download OpenAPI spec
curl http://localhost:8787/api/v1/openapi.json > openapi.json
```

---

## API Reference

### Health & Diagnostics

```bash
GET /health                      # Basic health check
GET /health/subscriptions        # Subscription status across shards
GET /shards/status               # Detailed shard health and asset distribution
GET /cron/health                 # Cron job error history
GET /test/all                    # Run all diagnostics
GET /test/websocket              # Test WebSocket connection
GET /test/clickhouse             # Test ClickHouse connection
```

### Market Data API (OpenAPI-enabled)

All endpoints support CORS and include rate limiting headers.

```bash
# Market listing and search
GET /api/v1/markets                      # List markets (paginated)
    ?limit=100&offset=0&market_source=polymarket&active=true

GET /api/v1/markets/search               # Search by question text
    ?q=election&limit=20

GET /api/v1/markets/:asset_id            # Get market details + 24h stats

# Orderbook data (sub-10ms latency from Durable Objects)
GET /api/v1/markets/:asset_id/orderbook  # Current orderbook snapshot

# OHLC candlestick data
GET /api/v1/ohlc/:asset_id               # Get OHLC candles
    ?interval=1m&hours=24                # interval: 1m or 5m
```

### Real-time Events (SSE)

```bash
# Authenticate first (sets httpOnly cookie)
POST /api/v1/auth
    -H "X-API-Key: your-api-key"

# Then connect to SSE stream
GET /api/v1/triggers/events/sse          # Real-time trigger events

# Or fetch buffered events
GET /api/v1/triggers/events              # Get last N events
    ?limit=20&type=PRICE_ABOVE

GET /api/v1/triggers/events/status       # SSE buffer status
```

### Backtest/Export API (Protected)

Requires `X-API-Key` header.

```bash
# Export historical data
GET /api/v1/backtest/export/backtest
    ?asset_id=123&start=2024-01-01&end=2024-01-31
    &granularity=tick&limit=100000       # granularity: tick or ohlc

# List assets available for backtesting
GET /api/v1/backtest/export/assets
    ?min_ticks=1000&limit=100

# Data quality metrics
GET /api/v1/backtest/export/quality/:asset_id
```

### Trigger Management (Protected)

Requires `X-API-Key` header.

```bash
GET    /triggers                 # List all triggers
POST   /triggers                 # Register new trigger
DELETE /triggers                 # Delete trigger by ID
GET    /do/metrics               # Aggregated latency metrics (public)
```

### Market Lifecycle (Protected)

```bash
POST /lifecycle/check            # Manual lifecycle check
POST /lifecycle/webhooks         # Register lifecycle webhook
GET  /lifecycle/webhooks         # List webhooks
```

### Admin Operations (Protected)

```bash
POST /admin/bootstrap-markets    # Subscribe all active markets
POST /admin/migrate              # Create ClickHouse tables
POST /admin/init-triggers        # Register production triggers
POST /admin/delete-all-triggers  # Reset all triggers
POST /admin/cleanup-test-data    # Clean test markets
POST /cron/clear-errors          # Clear cron error history
```

---

## Rate Limiting

API requests are rate-limited based on user tier. Limits apply per-minute.

| Tier | Data Endpoints | Admin Endpoints |
|------|----------------|-----------------|
| Free | 60 req/min | 15 req/min |
| Pro (default) | 120 req/min | 30 req/min |
| Enterprise | 600 req/min | 120 req/min |

**Data endpoints**: GET requests to `/markets`, `/ohlc`, `/orderbook`, `/triggers/events`

**Admin endpoints**: POST/PUT/DELETE requests, `/triggers` management, `/lifecycle`, `/admin`

Rate limit headers are included in all responses:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 119
X-RateLimit-Reset: 1706812860
X-RateLimit-Tier: pro
```

Exempt paths (no rate limiting):
- `/health`
- `/api/v1/openapi.json`
- `/api/v1/docs`

---

## Trigger System

### Supported Trigger Types

| Type | Description |
|------|-------------|
| `PRICE_ABOVE` / `PRICE_BELOW` | Price threshold crossing |
| `SPREAD_NARROW` / `SPREAD_WIDE` | Spread extremes |
| `IMBALANCE_BID` / `IMBALANCE_ASK` | Book imbalance |
| `IMBALANCE_SHIFT` | Rapid imbalance change |
| `SIZE_SPIKE` | Large size at top of book |
| `PRICE_MOVE` | % price move in time window |
| `LARGE_FILL` | Significant size removed |
| `QUOTE_VELOCITY` | BBO update frequency |
| `STALE_QUOTE` | No update for threshold ms |
| `ARBITRAGE_BUY` | YES_ask + NO_ask < threshold |
| `ARBITRAGE_SELL` | YES_bid + NO_bid > threshold |

### Registering a Trigger

```bash
curl -X POST https://your-worker.workers.dev/triggers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "asset_id": "12345...",
    "condition_id": "0xabc...",
    "condition": {
      "type": "PRICE_ABOVE",
      "threshold": 0.90,
      "side": "BID"
    },
    "webhook_url": "https://your-endpoint.com/webhook",
    "webhook_secret": "optional_hmac_secret",
    "cooldown_ms": 10000
  }'
```

### Trigger Event Payload

```json
{
  "trigger_id": "trig_abc123",
  "trigger_type": "PRICE_ABOVE",
  "asset_id": "12345...",
  "condition_id": "0xabc...",
  "fired_at": 1706812800000000,
  "total_latency_us": 45000,
  "processing_latency_us": 8000,
  "best_bid": 0.92,
  "best_ask": 0.93,
  "mid_price": 0.925,
  "spread_bps": 108,
  "threshold": 0.90,
  "actual_value": 0.92
}
```

---

## Database Schema

See [schema/CLICKHOUSE_SCHEMA.md](schema/CLICKHOUSE_SCHEMA.md) for complete table documentation.

### Key Tables

| Table | Purpose | Retention |
|-------|---------|-----------|
| `ob_bbo` | BBO tick data | 90 days |
| `ob_snapshots` | Full L2 depth | 90 days |
| `trade_ticks` | Trade executions | 90 days |
| `ob_level_changes` | Order flow | 30 days |
| `market_metadata` | Market info | Permanent |

### Materialized Views

- `mv_ob_bbo_1m` - 1-minute OHLC bars
- `mv_ob_bbo_5m` - 5-minute OHLC bars
- `mv_ob_hourly_stats` - Hourly aggregated stats

---

## Monitoring

### Shard Metrics

```bash
curl https://your-worker.workers.dev/do/metrics
```

Returns latency percentiles (p50/p95/p99) and trigger counts per shard.

### Subscription Health

```bash
curl https://your-worker.workers.dev/health/subscriptions
```

Returns status of all 25 shards with asset counts and connection states.

### Cron Health

```bash
curl https://your-worker.workers.dev/cron/health
```

Returns last run times and error history for scheduled jobs.

### Cloudflare Dashboard

- **Workers Logs**: Real-time request/error logs
- **Queue Metrics**: Message throughput and DLQ depth
- **DO Metrics**: Request counts and CPU time

---

## Development

### Local Development

```bash
# Start worker and dashboard concurrently
pnpm run dev

# Worker only (port 8787)
pnpm run dev:worker

# Dashboard only (Vite dev server)
pnpm run dev:app

# Run tests
pnpm test
```

### Building & Deploying

```bash
# Build dashboard for production
pnpm run build:app

# Deploy worker to Cloudflare
pnpm run deploy

# Deploy dashboard to Cloudflare Pages
pnpm run deploy:app
```

### Testing

```bash
# Unit tests
pnpm test

# Test WebSocket connection
curl http://localhost:8787/test/websocket

# Test ClickHouse connection
curl http://localhost:8787/test/clickhouse

# Run all diagnostics
curl http://localhost:8787/test/all
```

### Dashboard App

The React dashboard (`app/`) is a separate package in the monorepo:

- **Stack**: React 18, Vite, TailwindCSS 4, TypeScript
- **Charts**: lightweight-charts for OHLC visualization
- **Data Fetching**: TanStack Query (React Query)
- **Port**: 5173 (Vite default) in development

Access the API documentation at `http://localhost:8787/api/v1/docs` when the worker is running.

---

## Troubleshooting

### No data in ClickHouse

1. Check credentials: `wrangler secret list`
2. Verify tables exist: `curl /admin/migrate`
3. Check worker logs: `wrangler tail`

### Triggers not firing

1. Verify subscription: `GET /health/subscriptions`
2. Check trigger registration: `GET /triggers`
3. Review cooldown settings

### Gap detection failures

1. Check `ob_gap_events` table for FAILED resolutions
2. Verify `HASH_CHAIN_CACHE` KV is accessible
3. Review dead letter queue for failed messages

### WebSocket disconnections

1. Check shard status: `GET /shards/status`
2. Review Cloudflare DO metrics for CPU limits
3. Verify Polymarket service status
