# Polymarket Data Enrichment Pipeline

A Cloudflare Workers project that enriches on-chain Polymarket trade data from Goldsky with market metadata and orderbook snapshots.

## Features

- **Metadata Enrichment**: Fetches market details from Polymarket's Gamma API and stores them in ClickHouse
- **Batch Processing**: Automatically batches API requests to minimize rate limiting
- **Deduplication**: Uses KV cache and ClickHouse ReplacingMergeTree to prevent duplicate data
- **Event Tracking**: Stores market events in a separate table with proper foreign key relationships

## Architecture

```
Goldsky Webhook → Extract Asset ID → Queue → Batch Consumer → Polymarket API → ClickHouse
                        ↓                                              ↓
                    KV Cache ←──────────────────────────────────── Cache Update
```

### Orderbook Data Architecture

┌─────────────────────────────────────────────────────────────────────────┐
│ PRODUCTION ARCHITECTURE │
├─────────────────────────────────────────────────────────────────────────┤
│ │
│ Polymarket WS ──► OrderbookManager DO │
│ │ │
│ ├──► evaluateTriggers() ──► Webhook (<10ms) │
│ │ │
│ ├──► ob_bbo (tick) ──► mv_ob_bbo_1m (CH MV) │
│ │ └──► mv_ob_bbo_5m (CH MV) │
│ │ │
│ ├──► ob_snapshots (5-min L2) │
│ ├──► ob_level_changes (order flow) │
│ └──► trade_ticks (executions) │
│ │
└─────────────────────────────────────────────────────────────────────────┘

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Cloudflare Resources

```bash
# Create KV namespace
wrangler kv:namespace create MARKET_CACHE

# Create queues
wrangler queues create metadata-fetch-queue
wrangler queues create orderbook-snapshot-queue

# Create R2 bucket
wrangler r2 bucket create polymarket-orderbooks
```

### 3. Update wrangler.toml

Update the KV namespace ID in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MARKET_CACHE"
id = "YOUR_KV_NAMESPACE_ID"  # Replace with your actual ID
```

### 4. Set Secrets

```bash
wrangler secret put CLICKHOUSE_URL
# Enter your ClickHouse URL (e.g., https://your-instance.clickhouse.cloud:8443)

wrangler secret put CLICKHOUSE_TOKEN
# Enter your ClickHouse access token

wrangler secret put WEBHOOK_API_KEY
# Enter a secure API key for Goldsky to use (e.g., generate with: openssl rand -hex 32)
```

### 5. Create ClickHouse Tables

Run the SQL schema in `schema/clickhouse.sql` against your ClickHouse instance:

```bash
clickhouse-client --host your-host --secure --password --query "$(cat schema/clickhouse.sql)"
```

Or execute via the ClickHouse web console.

### 6. Deploy

```bash
wrangler deploy
```

## Usage

### Webhook Endpoint

Send Goldsky trade events to the `/webhook/goldsky` endpoint with your API key:

**Endpoint:** `https://cd-durbin14.workers.dev/webhook/goldsky`

**Headers Required:**

- `Content-Type: application/json`
- `X-API-Key: your-secret-api-key`

**Example:**

```bash
curl -X POST https://cd-durbin14.workers.dev/webhook/goldsky \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-api-key" \
  -d '{
    "id": "46268262",
    "transaction_hash": "0x000000eae9b9fbc15b35e567f3ee3390d75400a0930b7775fcd6b671ec7db701",
    "timestamp": "1748971146",
    "order_hash": "0",
    "maker": "0x...",
    "taker": "0x...",
    "maker_asset_id": "9022242446965460992675148513465279956952237358463225683411818753752794850571",
    "taker_asset_id": "0",
    "maker_amount_filled": "98235000",
    "taker_amount_filled": "555000000",
    "fee": "0",
    "chain_id": 137,
    "_gs_chain": "matic",
    "_gs_gid": "d67f1e4524969bcaa6e732e50d7c2d27",
    "is_deleted": 0
  }'
```

### How It Works

1. **Asset ID Extraction**: The webhook extracts the active asset ID (the one that's not "0")
2. **Cache Check**: Checks KV cache to see if we already have this market's metadata
3. **Queue Job**: If not cached, queues a metadata fetch job
4. **Batch Processing**: Queue consumer batches multiple jobs (max 10 jobs or 5 seconds)
5. **Deduplication**: Filters out tokens already in cache
6. **Batch API Request**: Makes a single request to Polymarket with all uncached token IDs
7. **ClickHouse Insert**: Inserts market metadata and events into ClickHouse
8. **Cache Update**: Updates KV cache for future lookups

### Batching Strategy

The metadata consumer uses Cloudflare's built-in queue batching:

- **Max Batch Size**: 10 jobs
- **Max Batch Timeout**: 5 seconds

This means the consumer will process up to 10 jobs at once, or wait up to 5 seconds to accumulate jobs before processing.

### Deduplication

Deduplication happens at multiple levels:

1. **KV Cache**: Before fetching from Polymarket, checks if we already have the data
2. **ReplacingMergeTree**: ClickHouse table engine that automatically deduplicates by primary key
3. **Batch Deduplication**: Within a single batch, only unique token IDs are fetched

## Data Schema

### market_metadata Table

Stores core market information:

| Column                    | Type     | Description                  |
| ------------------------- | -------- | ---------------------------- |
| id                        | String   | Polymarket market ID         |
| question                  | String   | Market question              |
| condition_id              | String   | Blockchain condition ID      |
| slug                      | String   | URL-friendly slug            |
| resolution_source         | String   | Source for market resolution |
| end_date                  | DateTime | Market end date              |
| start_date                | DateTime | Market start date            |
| created_at                | DateTime | Creation timestamp           |
| submitted_by              | String   | Creator address              |
| resolved_by               | String   | Resolver address             |
| restricted                | UInt8    | Whether market is restricted |
| enable_order_book         | UInt8    | Whether orderbook is enabled |
| order_price_min_tick_size | Float64  | Minimum price tick           |
| order_min_size            | Float64  | Minimum order size           |
| clob_token_ids            | String   | JSON array of token IDs      |
| neg_risk                  | UInt8    | Negative risk flag           |
| neg_risk_market_id        | String   | Neg risk market ID           |
| neg_risk_request_id       | String   | Neg risk request ID          |

### market_events Table

Stores events associated with markets:

| Column    | Type   | Description                       |
| --------- | ------ | --------------------------------- |
| event_id  | String | Event ID                          |
| market_id | String | Foreign key to market_metadata.id |
| title     | String | Event title                       |

### Linking Markets and Events

To query markets with their events:

```sql
SELECT
    m.id,
    m.question,
    e.event_id,
    e.title as event_title
FROM market_metadata m
LEFT JOIN market_events e ON m.id = e.market_id
WHERE m.condition_id = 'your_condition_id'
```

## Development

### Local Development

```bash
npm run dev
```

### Testing

```bash
npm test
```

## Monitoring

Check logs for processing information:

```bash
wrangler tail
```

Key log messages:

- `Processing X unique token IDs` - Number of unique tokens in batch
- `X tokens not in cache` - Number of tokens that need fetching
- `Fetched X markets from Polymarket` - API response count
- `Inserted X market metadata records` - ClickHouse insert count
- `Inserted X event records` - Events inserted

## Troubleshooting

### No data in ClickHouse

1. Check ClickHouse credentials: `wrangler secret list`
2. Verify tables exist: Run `SHOW TABLES` in ClickHouse
3. Check worker logs: `wrangler tail`

### Duplicate data

- ReplacingMergeTree will handle duplicates automatically
- Run `OPTIMIZE TABLE market_metadata FINAL` to force merge

### API rate limiting

- Batching reduces API calls significantly
- KV cache prevents redundant fetches
- Adjust `max_batch_timeout` in wrangler.toml if needed

## Next Steps

- [ ] Add orderbook snapshot consumer
- [ ] Implement WebSocket orderbook manager
- [ ] Add monitoring and alerting
- [ ] Set up CI/CD pipeline
