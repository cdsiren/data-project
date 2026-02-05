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

## Data Reconciliation

Before deleting any data from ClickHouse, you **must** verify that all archived data in R2 matches the source data. The reconciliation system provides multiple ways to validate data integrity.

### Overview

The reconciliation process compares:
1. **R2 Manifests**: JSON files tracking all archived Parquet files with row counts
2. **ClickHouse Data**: The source data that was archived
3. **Archive Log**: The `trading_data.archive_log` table tracking archive operations

All three should be consistent within a 1% tolerance (to account for in-flight data during archival).

### Admin Endpoints

Three endpoints are available for reconciliation checks:

#### GET /admin/manifest/:database/:table

Fetch a single table's manifest from R2.

```bash
curl "https://polymarket-enrichment.cd-durbin14.workers.dev/admin/manifest/trading_data/ob_bbo" \
  -H "X-API-Key: YOUR_API_KEY"
```

**Response:**
```json
{
  "database": "trading_data",
  "table": "ob_bbo",
  "lastUpdated": "2024-01-15T10:30:00Z",
  "totalRows": 15000000,
  "entries": [
    {
      "path": "trading_data/resolved/0x.../ob_bbo/2024-01/data.parquet",
      "rows": 50000,
      "minTs": "2024-01-01T00:00:00Z",
      "maxTs": "2024-01-31T23:59:59Z",
      "archivedAt": "2024-02-01T02:00:00Z",
      "sizeBytes": 2500000
    }
  ]
}
```

#### GET /admin/manifests

Fetch all table manifests from R2.

```bash
curl "https://polymarket-enrichment.cd-durbin14.workers.dev/admin/manifests" \
  -H "X-API-Key: YOUR_API_KEY"
```

**Response:**
```json
{
  "count": 4,
  "manifests": [
    { "database": "trading_data", "table": "ob_bbo", "totalRows": 15000000, ... },
    { "database": "trading_data", "table": "trade_ticks", "totalRows": 8000000, ... },
    { "database": "trading_data", "table": "ob_snapshots", "totalRows": 2000000, ... },
    { "database": "trading_data", "table": "ob_level_changes", "totalRows": 12000000, ... }
  ]
}
```

#### GET /admin/reconciliation

Run a full reconciliation comparing R2 manifests to ClickHouse row counts.

```bash
curl "https://polymarket-enrichment.cd-durbin14.workers.dev/admin/reconciliation" \
  -H "X-API-Key: YOUR_API_KEY"
```

**Response:**
```json
{
  "summary": {
    "tablesChecked": 4,
    "tablesOk": 4,
    "tablesMismatch": 0,
    "tablesError": 0,
    "totalManifestRows": 37000000,
    "totalClickhouseRows": 37150000,
    "totalDifference": 150000,
    "totalPercentDiff": 0.4,
    "overallStatus": "ok"
  },
  "tables": [
    {
      "database": "trading_data",
      "table": "ob_bbo",
      "manifestRows": 15000000,
      "clickhouseRows": 15050000,
      "difference": 50000,
      "percentDiff": 0.33,
      "status": "ok"
    }
  ]
}
```

**Status values:**
- `ok`: Difference is within 1% tolerance
- `mismatch`: Difference exceeds 1% tolerance
- `clickhouse_error`: Could not query ClickHouse

### Quick Reconciliation Check

Use the provided shell script for a quick command-line check:

```bash
# Set your API key
export VITE_DASHBOARD_API_KEY=your-api-key

# Run the reconciliation check
./scripts/check-r2-clickhouse-reconciliation.sh
```

**Example output:**
```
=== R2 to ClickHouse Data Reconciliation ===
Worker URL: https://polymarket-enrichment.cd-durbin14.workers.dev

Fetching reconciliation data...

=== Summary ===
{
  "tablesChecked": 4,
  "tablesOk": 4,
  "overallStatus": "ok"
}

=== Table Details ===
✓ trading_data.ob_bbo: R2=15,000,000 CH=15,050,000 diff=0.33%
✓ trading_data.trade_ticks: R2=8,000,000 CH=8,020,000 diff=0.25%
✓ trading_data.ob_snapshots: R2=2,000,000 CH=2,005,000 diff=0.25%
✓ trading_data.ob_level_changes: R2=12,000,000 CH=12,075,000 diff=0.63%

✓ All tables reconciled successfully. Safe to proceed with deletion.
```

### Automated Test Suite

For comprehensive validation, run the test suite:

```bash
# Set environment variables
export CLICKHOUSE_URL=https://your-clickhouse-host:8443
export CLICKHOUSE_TOKEN=your-token
export CLICKHOUSE_USER=default
export API_KEY=your-api-key
export WORKER_URL=https://polymarket-enrichment.cd-durbin14.workers.dev

# Run reconciliation tests
pnpm test src/tests/data-validation/r2-clickhouse-reconciliation.test.ts
```

**Test coverage:**
- `should have at least one manifest to reconcile` - Verifies manifests exist
- `should reconcile ob_bbo table` - Validates BBO data
- `should reconcile trade_ticks table` - Validates trade data
- `should reconcile ob_snapshots table` - Validates snapshot data
- `should reconcile ob_level_changes table` - Validates level change data
- `should reconcile all archived tables` - Full cross-table validation
- `should verify archive_log matches manifests` - Cross-checks archive log

### Reconciliation Workflow

**Before deleting ClickHouse data:**

1. **Run quick check** (1 minute):
   ```bash
   ./scripts/check-r2-clickhouse-reconciliation.sh
   ```

2. **If quick check passes**, run full test suite (5-10 minutes):
   ```bash
   pnpm test src/tests/data-validation/r2-clickhouse-reconciliation.test.ts
   ```

3. **Verify archive_log** shows no pending deletions:
   ```sql
   SELECT count(*) AS pending_deletions
   FROM trading_data.archive_log
   WHERE clickhouse_deleted = 0
     AND archived_at < NOW() - INTERVAL 1 DAY
   ```

4. **Only proceed with deletion** if all checks pass

### Troubleshooting Mismatches

**Common causes of row count differences:**

| Cause | Resolution |
|-------|------------|
| In-flight data during archival | Wait 24 hours, re-run check |
| Failed archive job | Check dead_letter_messages, re-queue job |
| Partial archive (timeout) | Re-run archive for affected month |
| Manifest corruption | Re-archive table, regenerate manifest |

**Investigating mismatches:**

```sql
-- Find specific time ranges with differences
SELECT
  toStartOfDay(source_ts) AS day,
  count() AS ch_rows
FROM trading_data.ob_bbo
WHERE source_ts BETWEEN '2024-01-01' AND '2024-01-31'
GROUP BY day
ORDER BY day;

-- Compare with manifest entry
-- Check manifest.entries where minTs/maxTs covers this range
```

**Re-archiving a specific time range:**

```typescript
// Queue a re-archive job for a specific market
await env.ARCHIVE_QUEUE.send({
  type: "resolved",
  conditionId: "0x...",
});

// Or for aged data
await env.ARCHIVE_QUEUE.send({
  type: "aged",
  database: "trading_data",
  table: "ob_bbo",
  month: "2024-01",
});
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
| `src/config/database.ts` | ARCHIVE_TABLE_REGISTRY, R2_PATHS |
| `src/routes/backtest.ts` | Tier-enforced backtest endpoints |
| `src/services/market-lifecycle.ts` | Archive trigger on market resolution |
| `schema/orderbook_tables.sql` | archive_log, usage_events tables |
| `src/tests/data-validation/r2-clickhouse-reconciliation.test.ts` | Reconciliation test suite |
| `scripts/check-r2-clickhouse-reconciliation.sh` | Quick reconciliation CLI script |
| `src/index.ts` | Admin endpoints: `/admin/manifest/*`, `/admin/reconciliation` |
