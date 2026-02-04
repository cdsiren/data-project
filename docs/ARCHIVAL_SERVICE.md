# Archival Service

This document describes the tiered data archival system for reducing ClickHouse storage costs while maintaining historical data access through R2-backed cold storage.

## Overview

The archival system implements a hybrid storage strategy:
- **Hot storage** (ClickHouse): Recent data (~90 days) for low-latency queries
- **Cold storage** (R2): Historical data in Parquet format for cost-effective storage

Data is archived based on two triggers:
1. **Market resolution**: When a market's `end_date` is more than 7 days in the past
2. **Age-based**: When data is older than 90 days

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Archival System Architecture                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │   ClickHouse    │     │  Archive Queue  │     │   R2 Bucket     │   │
│  │  (Hot Storage)  │────▶│    (Workers)    │────▶│ (Cold Storage)  │   │
│  │   ~90 days      │     │                 │     │   Parquet       │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘   │
│           │                      │                       │              │
│           │                      │                       │              │
│           ▼                      ▼                       ▼              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Query Router                                │   │
│  │  Determines hot/cold/hybrid query paths based on date range     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## R2 Bucket Structure

```
trading-data-archive/
├── trading_data/
│   ├── resolved/{condition_id}/
│   │   ├── ob_bbo/{YYYY-MM}/data.parquet
│   │   ├── ob_snapshots/{YYYY-MM}/data.parquet
│   │   ├── trade_ticks/{YYYY-MM}/data.parquet
│   │   └── ob_level_changes/{YYYY-MM}/data.parquet
│   ├── aged/
│   │   ├── trades/{YYYY-MM}/data.parquet
│   │   ├── makers/{YYYY-MM}/data.parquet
│   │   ├── takers/{YYYY-MM}/data.parquet
│   │   └── markets/{YYYY-MM}/data.parquet
│   └── operational/
│       ├── ob_gap_events/{YYYY-MM}/data.parquet
│       └── dead_letter_messages/{YYYY-MM}/data.parquet
├── raw_polymarket/
│   ├── global_open_interest/{YYYY-MM}/data.parquet
│   ├── market_open_interest/{YYYY-MM}/data.parquet
│   ├── order_filled/{YYYY-MM}/data.parquet
│   ├── orders_matched/{YYYY-MM}/data.parquet
│   └── user_positions/{YYYY-MM}/data.parquet
└── manifests/
    └── {database}_{table}.json
```

## Archive Triggers

### Market Resolution (trading_data tables with condition_id)

Tables with market-specific data are archived when the associated market resolves:

- **Trigger**: `end_date < NOW() - INTERVAL 7 DAY`
- **Tables**: `ob_bbo`, `ob_snapshots`, `trade_ticks`, `ob_level_changes`
- **Key column**: `condition_id`

The 7-day grace period ensures:
1. Final trades and order book activity are captured
2. Any late data from WebSocket reconnections is included
3. Users have time to export their data before archival

### Block Range (raw_polymarket tables)

Tables using The Graph's `block_range` format for versioning:

- **Trigger**: Block start number is older than ~90 days
- **Tables**: `global_open_interest`, `market_open_interest`, `user_positions`
- **Calculation**: `currentBlock - 3,888,000` (~90 days at 1 block/2 seconds)

Block range format: `[start_block,end_block)` or `[start_block,)` for open ranges.

### Age-Based (all other tables)

Operational and timestamp-based tables are archived based on age:

- **Trigger**: Timestamp column older than 90 days
- **Tables**: `trades`, `makers`, `takers`, `markets`, `order_filled`, `orders_matched`, `ob_gap_events`, `dead_letter_messages`

## Tier-Based Access Control

Historical data access is controlled by the user's data tier:

| Tier | Historical Data | Backtest Access | Export Formats | Overage Rate |
|------|-----------------|-----------------|----------------|--------------|
| **Starter** | 7 days | None | - | N/A |
| **Pro** | 90 days | Read-only | JSON | $0.005/1K rows |
| **Team** | 1 year | Full + Export | JSON, CSV, Parquet | $0.003/1K rows |
| **Business** | Unlimited | Full + Bulk API | All formats | $0.001/1K rows |

### Tier Limits Enforcement

Date range validation occurs at the middleware level:

```typescript
// Request flow
Request → Auth → Tier Check → Date Range Validation → Query Execution
                     │                │
                     ▼                ▼
              403 if no access   403 if date range exceeds tier limit
```

## Query Patterns

### Hot Data (ClickHouse Direct)

For data within the 90-day window, queries execute directly against ClickHouse:

```sql
SELECT * FROM trading_data.ob_bbo
WHERE asset_id = '...'
  AND source_ts BETWEEN '2024-01-01' AND '2024-01-31'
```

### Cold Data (R2 via ClickHouse S3())

For archived data, ClickHouse queries R2 using the S3() function:

```sql
SELECT * FROM s3(
  'https://{account}.r2.cloudflarestorage.com/trading-data-archive/trading_data/resolved/{condition_id}/ob_bbo/2023-06/data.parquet',
  'Parquet'
)
WHERE source_ts BETWEEN '2023-06-01' AND '2023-06-30'
```

### Hybrid Queries

When a date range spans both hot and cold data, results are merged:

```typescript
const [hotData, coldData] = await Promise.all([
  queryClickHouse(assetId, hotStart, hotEnd),
  queryR2ViaClickHouse(assetId, coldStart, coldEnd),
]);
return mergeResults(hotData, coldData);
```

### Bulk Export (Team/Business Tiers)

For large exports, presigned URLs are returned for direct Parquet download:

```json
{
  "format": "parquet",
  "files": [
    { "path": "ob_bbo/2023-06/data.parquet", "url": "https://...signed-url..." },
    { "path": "ob_bbo/2023-07/data.parquet", "url": "https://...signed-url..." }
  ],
  "expires_in": 3600,
  "query_example": "SELECT * FROM read_parquet(['url1', 'url2'])"
}
```

## API Endpoints

### Backtest Data Export

```
GET /api/v1/backtest/export/backtest
  ?asset_id={asset_id}
  &start={ISO_date}
  &end={ISO_date}
  &granularity={tick|ohlc}
  &limit={number}
```

**Tier restrictions:**
- Starter: 403 Forbidden
- Pro: JSON only, 90-day limit
- Team/Business: All formats, extended limits

### Bulk Export

```
GET /api/v1/backtest/export/bulk/{condition_id}
  ?start={ISO_date}
  &end={ISO_date}
  &format={json|csv|parquet}
```

**Tier restrictions:**
- Starter/Pro: 403 Forbidden
- Team/Business: Full access

### Usage Tracking

```
GET /api/v1/backtest/usage
```

Returns current billing cycle usage and estimated costs.

### Tier Information

```
GET /api/v1/backtest/tier
```

Returns current tier and its limits.

## Usage Tracking & Billing

Every backtest query tracks:
- API key (hashed)
- Rows returned
- Endpoint accessed
- Timestamp

Data is stored in `trading_data.usage_events` for billing aggregation:

```sql
SELECT
  api_key_hash,
  tier,
  billing_cycle,
  sum(rows_returned) AS total_rows,
  sum(rows_returned) / 1000 * overage_rate AS estimated_cost
FROM trading_data.usage_events
WHERE billing_cycle = '2024-01'
GROUP BY api_key_hash, tier, billing_cycle
```

## Scheduled Jobs

### 5-Minute Cron (`*/5 * * * *`)

- Checks for resolved markets ready for archival
- Queues archive jobs for markets with `end_date > 7 days ago`

### Hourly Cron (`2 * * * *`)

- Refreshes market metadata from Gamma API
- Ensures market_metadata table stays current

### Daily Cron (`0 2 * * *`)

- Archives aged data (>90 days) across all tables
- Runs at 2 AM UTC to minimize query impact
- Processes all tables in ARCHIVE_TABLE_REGISTRY

## Operations

### Manual Backfill

To archive historical data not yet archived:

```typescript
import { runArchiveBackfill } from "./consumers/archive-consumer";

const result = await runArchiveBackfill(env);
console.log(`Queued ${result.marketsQueued} resolved market jobs`);
console.log(`Queued ${result.agedTablesQueued} aged data jobs`);
```

### Monitoring Queries

**Check archive status:**
```sql
SELECT
  archive_type,
  table_name,
  count() AS archives,
  sum(rows_archived) AS total_rows,
  min(min_source_ts) AS oldest_data,
  max(max_source_ts) AS newest_data
FROM trading_data.archive_log
GROUP BY archive_type, table_name
ORDER BY table_name
```

**Check for unarchived resolved markets:**
```sql
SELECT count() AS unarchived_markets
FROM trading_data.market_metadata mm
WHERE mm.end_date < NOW() - INTERVAL 7 DAY
  AND mm.condition_id NOT IN (
    SELECT DISTINCT condition_id
    FROM trading_data.archive_log
    WHERE archive_type = 'resolved'
  )
```

**Monitor queue backlog:**
```sql
SELECT
  original_queue,
  message_type,
  count() AS failed_count,
  max(failed_at) AS last_failure
FROM trading_data.dead_letter_messages
WHERE original_queue = 'archive-queue'
GROUP BY original_queue, message_type
```

### Recovery Procedures

**Re-archive failed market:**
```typescript
const queue = env.ARCHIVE_QUEUE;
await queue.send({
  type: "resolved",
  conditionId: "CONDITION_ID_HERE"
});
```

**Verify archive integrity:**
```typescript
const service = new ArchiveService(env);
const manifest = await bucket.get("manifests/trading_data_ob_bbo.json");
// Compare row counts with archive_log
```

## Configuration

### wrangler.toml

```toml
[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "trading-data-archive"

[[queues.producers]]
queue = "archive-queue"
binding = "ARCHIVE_QUEUE"

[[queues.consumers]]
queue = "archive-queue"
max_batch_size = 10
max_batch_timeout = 300
max_retries = 3
dead_letter_queue = "dead-letter-queue"

[triggers]
crons = ["*/5 * * * *", "2 * * * *", "0 2 * * *"]
```

### R2 Bucket Setup

```bash
# Create the bucket
wrangler r2 bucket create trading-data-archive

# Verify
wrangler r2 bucket list
```

## Cost Impact

| Component | Before | After |
|-----------|--------|-------|
| ClickHouse storage | ~$500-800/mo | ~$200/mo |
| R2 storage (1TB) | - | ~$15/mo |
| R2 operations | - | ~$5/mo |
| **Total** | ~$600/mo | ~$220/mo |

**Estimated savings: ~60%**

## File Reference

| File | Purpose |
|------|---------|
| `src/schemas/common.ts` | DataTier enum and TIER_LIMITS |
| `src/middleware/rate-limiter.ts` | validateDateRange(), usageTracker() |
| `src/services/archive-service.ts` | Core archival logic |
| `src/services/archive-query.ts` | Hot/cold query routing |
| `src/consumers/archive-consumer.ts` | Queue consumer for archive jobs |
| `src/config/database.ts` | ARCHIVE_TABLE_REGISTRY |
| `src/routes/backtest.ts` | Tier-enforced backtest endpoints |
| `src/services/market-lifecycle.ts` | Archive trigger on market resolution |
| `schema/orderbook_tables.sql` | archive_log, usage_events tables |
