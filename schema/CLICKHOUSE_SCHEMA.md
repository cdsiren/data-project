# ClickHouse Schema Reference

This document provides a complete reference for all ClickHouse tables used in the Polymarket Data Enrichment Pipeline.

## Table of Contents

- [Trading Data Tables](#trading-data-tables)
  - [trades](#trades)
  - [trade_ticks](#trade_ticks)
  - [makers](#makers)
  - [takers](#takers)
  - [markets](#markets)
- [Orderbook Tables](#orderbook-tables)
  - [ob_bbo](#ob_bbo)
  - [ob_snapshots](#ob_snapshots)
  - [ob_level_changes](#ob_level_changes)
  - [ob_gap_events](#ob_gap_events)
  - [ob_latency](#ob_latency)
- [Operational Tables](#operational-tables)
  - [dead_letter_messages](#dead_letter_messages)
  - [archive_log](#archive_log)
  - [usage_events](#usage_events)
- [Market Metadata Tables](#market-metadata-tables)
  - [market_metadata](#market_metadata)
  - [market_events](#market_events)
- [Views](#views)
  - [v_ob_bbo_1m](#v_ob_bbo_1m)
  - [v_ob_bbo_5m](#v_ob_bbo_5m)
- [Materialized Views](#materialized-views)
  - [trades_mv](#trades_mv)
  - [makers_mv](#makers_mv)
  - [takers_mv](#takers_mv)
  - [markets_mv](#markets_mv)
  - [mv_ob_bbo_1m](#mv_ob_bbo_1m)
  - [mv_ob_bbo_5m](#mv_ob_bbo_5m)
  - [mv_ob_hourly_stats](#mv_ob_hourly_stats)
  - [mv_ob_latency_hourly](#mv_ob_latency_hourly)
- [Raw Polymarket Database Tables](#raw-polymarket-database-tables)
  - [global_open_interest](#global_open_interest)
  - [market_open_interest](#market_open_interest)
  - [order_filled](#order_filled)
  - [orders_matched](#orders_matched)
  - [user_positions](#user_positions)

---

## Trading Data Tables

### trades

Primary storage for raw trade execution data from Polymarket.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| id | String | | Trade ID |
| transaction_hash | String | | Blockchain transaction hash |
| order_hash | String | | Order hash |
| timestamp | DateTime64(0) | | Trade execution time |
| maker | String | | Maker address |
| taker | String | | Taker address |
| maker_asset_id | String | | Maker's asset ID |
| taker_asset_id | String | | Taker's asset ID |
| side | String | | Trade side (BUY/SELL) |
| token_id | String | | Token identifier |
| size_raw | UInt256 | | Raw size in base units |
| size | Float64 | | Normalized size |
| usdc_volume_raw | UInt256 | | Raw USDC volume |
| usdc_volume | Float64 | | Normalized USDC volume |
| price | Float64 | | Execution price |
| fee_raw | UInt256 | | Raw fee amount |
| fee_usdc | Float64 | | Fee in USDC |
| chain_id | Int64 | | Blockchain chain ID |

---

### trade_ticks

Lightweight trade tick data for time-series analysis with sub-second precision.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| condition_id | String | | Market condition ID |
| trade_id | String | | Trade identifier |
| price | Decimal(38, 18) | | Trade price (high precision) |
| size | Float64 | | Trade size |
| side | LowCardinality(String) | | Trade side |
| source_ts | DateTime64(3, 'UTC') | | Exchange timestamp (ms) |
| ingestion_ts | DateTime64(6, 'UTC') | | Ingestion timestamp (us) |
| latency_ms | Float64 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |
| notional | Decimal(38, 18) | MATERIALIZED | `price * toDecimal128(size, 18)` |

---

### makers

Aggregated maker activity by user and token.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| user | String | | Maker address |
| token_id | String | | Token identifier |
| timestamp | DateTime | | Aggregation timestamp |
| trades_count | UInt64 | | Number of trades |
| usdc_volume_raw | UInt64 | | Raw USDC volume |
| usdc_volume | Float64 | | Normalized USDC volume |

---

### takers

Aggregated taker activity by user and token.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| user | String | | Taker address |
| token_id | String | | Token identifier |
| timestamp | DateTime | | Aggregation timestamp |
| trades_count | UInt64 | | Number of trades |
| usdc_volume_raw | UInt64 | | Raw USDC volume |
| usdc_volume | Float64 | | Normalized USDC volume |

---

### markets

Aggregated market-level trading statistics.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| token_id | String | | Token identifier |
| timestamp | DateTime | | Aggregation timestamp |
| trades_count | UInt64 | | Total trade count |
| buys_count | UInt64 | | Buy trade count |
| sells_count | UInt64 | | Sell trade count |
| usdc_volume_raw | UInt64 | | Raw USDC volume |
| usdc_volume | Float64 | | Normalized USDC volume |
| shares_volume_raw | UInt64 | | Raw shares volume |
| fees_raw | UInt64 | | Raw fees collected |

---

## Orderbook Tables

### ob_bbo

Best Bid/Offer (top-of-book) tick data. Lightweight alternative to full L2 snapshots (~20-50x smaller).

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| condition_id | String | | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | | Polymarket timestamp |
| ingestion_ts | DateTime64(6, 'UTC') | | Our receipt timestamp |
| book_hash | String | | Hash for dedup/gap detection |
| best_bid | Decimal(38, 18) | | Best bid price |
| best_ask | Decimal(38, 18) | | Best ask price |
| bid_size | Float64 | | Size at best bid |
| ask_size | Float64 | | Size at best ask |
| mid_price | Decimal(38, 18) | | Mid price |
| spread_bps | Float64 | | Spread in basis points |
| tick_size | Decimal(38, 18) | | Price tick size |
| is_resync | UInt8 | 0 | 1 if from gap backfill |
| sequence_number | UInt64 | | Sequence for ordering |
| neg_risk | UInt8 | 0 | Negative risk flag |
| order_min_size | Float64 | 0 | Minimum order size |
| spread | Decimal(38, 18) | MATERIALIZED | `best_ask - best_bid` |
| latency_ms | Float64 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |

**TTL:** 90 days

---

### ob_snapshots

Full L2 orderbook snapshots with depth arrays.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| condition_id | String | | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | | Polymarket timestamp |
| ingestion_ts | DateTime64(6, 'UTC') | | Our receipt timestamp |
| book_hash | String | | Hash for dedup/gap detection |
| bid_prices | Array(Decimal128(18)) | | Bid price levels |
| bid_sizes | Array(Float64) | | Sizes at each bid level |
| ask_prices | Array(Decimal128(18)) | | Ask price levels |
| ask_sizes | Array(Float64) | | Sizes at each ask level |
| tick_size | Decimal128(18) | | Price tick size |
| is_resync | UInt8 | 0 | 1 if from gap backfill |
| sequence_number | UInt64 | | Sequence for ordering |
| neg_risk | UInt8 | 0 | Negative risk flag |
| order_min_size | Float64 | 0 | Minimum order size |
| best_bid | Decimal128(18) | MATERIALIZED | First bid price |
| best_ask | Decimal128(18) | MATERIALIZED | First ask price |
| mid_price | Decimal128(18) | MATERIALIZED | `(best_bid + best_ask) / 2` |
| spread | Decimal128(18) | MATERIALIZED | `best_ask - best_bid` |
| spread_bps | Float64 | MATERIALIZED | Spread in basis points |
| total_bid_depth | Float64 | MATERIALIZED | `arraySum(bid_sizes)` |
| total_ask_depth | Float64 | MATERIALIZED | `arraySum(ask_sizes)` |
| bid_levels | UInt16 | MATERIALIZED | Number of bid levels |
| ask_levels | UInt16 | MATERIALIZED | Number of ask levels |
| book_imbalance | Float64 | MATERIALIZED | `(bid_depth - ask_depth) / (bid_depth + ask_depth)` |

**TTL:** 90 days

---

### ob_level_changes

Order book level changes tracking placements and cancellations at each price level.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| condition_id | String | | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | | Polymarket timestamp |
| ingestion_ts | DateTime64(6, 'UTC') | | Our receipt timestamp |
| side | LowCardinality(String) | | 'BUY' or 'SELL' |
| price | Decimal(38, 18) | | Price level |
| old_size | Float64 | | Previous size at level |
| new_size | Float64 | | New size at level |
| size_delta | Float64 | | `new_size - old_size` |
| change_type | LowCardinality(String) | | 'ADD', 'REMOVE', 'UPDATE' |
| book_hash | String | | Book state hash |
| sequence_number | UInt64 | | Sequence for ordering |
| latency_ms | Float64 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |

**TTL:** 30 days

---

### ob_gap_events

Gap detection audit log for orderbook data integrity.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| detected_at | DateTime64(6, 'UTC') | | Detection timestamp |
| last_known_hash | String | | Last seen book hash |
| new_hash | String | | New book hash after gap |
| gap_duration_ms | Float64 | | Gap duration in ms |
| resolution | String | | Gap resolution status |

---

### ob_latency

Ingestion latency metrics for monitoring.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| asset_id | String | | Asset identifier |
| source_ts | DateTime64(3, 'UTC') | | Polymarket timestamp |
| ingestion_ts | DateTime64(6, 'UTC') | | Our receipt timestamp |
| latency_ms | Float64 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |
| event_type | LowCardinality(String) | | Event type |

**TTL:** 7 days

---

## Operational Tables

### dead_letter_messages

Failed queue messages stored for debugging and retry analysis.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| market_source | LowCardinality(String) | 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | 'prediction' | Market type |
| original_queue | LowCardinality(String) | | Source queue name |
| message_type | LowCardinality(String) | | Message type (bbo_snapshot, etc.) |
| payload | String | | JSON serialized original message |
| error | String | | Error message |
| failed_at | DateTime64(3, 'UTC') | | Failure timestamp |
| received_at | DateTime64(3, 'UTC') | | Original receipt timestamp |
| retry_count | UInt8 | | Number of retry attempts |

**Engine:** MergeTree
**Partition:** toYYYYMM(failed_at)
**Order:** (original_queue, message_type, failed_at)
**TTL:** 30 days
**Index:** idx_error (tokenbf_v1 on error column)

---

### archive_log

Tracks data archival operations to R2 cold storage.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| condition_id | String | | Market condition ID (empty for aged archives) |
| archive_type | LowCardinality(String) | | 'resolved' or 'aged' |
| table_name | LowCardinality(String) | | Source table name |
| r2_path | String | | Full R2 object path |
| rows_archived | UInt64 | | Number of rows in archive |
| min_source_ts | DateTime64(3, 'UTC') | | Earliest timestamp in archive |
| max_source_ts | DateTime64(3, 'UTC') | | Latest timestamp in archive |
| archived_at | DateTime64(3, 'UTC') | | When archival occurred |
| clickhouse_deleted | UInt8 | 0 | 1 if data deleted from ClickHouse |

**Engine:** MergeTree
**Partition:** toYYYYMM(archived_at)
**Order:** (condition_id, table_name, archived_at)
**Index:** idx_archive_type (set on archive_type)

**Usage:**
```sql
-- Check archive status by table
SELECT
    archive_type,
    table_name,
    count() AS archives,
    sum(rows_archived) AS total_rows
FROM trading_data.archive_log
GROUP BY archive_type, table_name;

-- Find unarchived resolved markets
SELECT DISTINCT mm.condition_id
FROM trading_data.market_metadata mm
WHERE mm.end_date < NOW() - INTERVAL 7 DAY
  AND mm.condition_id NOT IN (
    SELECT DISTINCT condition_id FROM trading_data.archive_log
    WHERE archive_type = 'resolved'
  );
```

---

### usage_events

Tracks API usage for tier-based billing and usage analytics.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| api_key_hash | String | | Hashed API key (privacy) |
| tier | LowCardinality(String) | | Data tier (starter, pro, team, business) |
| endpoint | String | | API endpoint path |
| rows_returned | UInt64 | | Number of rows in response |
| timestamp | DateTime64(3, 'UTC') | | Request timestamp |
| billing_cycle | String | | YYYY-MM format for billing period |

**Engine:** MergeTree
**Partition:** billing_cycle
**Order:** (api_key_hash, timestamp)
**TTL:** 365 days
**Index:** idx_billing_cycle (set on billing_cycle)

**Usage:**
```sql
-- Get usage summary for a billing cycle
SELECT
    api_key_hash,
    tier,
    sum(rows_returned) AS total_rows,
    count() AS request_count
FROM trading_data.usage_events
WHERE billing_cycle = '2024-01'
GROUP BY api_key_hash, tier;
```

---

## Market Metadata Tables

### market_metadata

Core market information from the Gamma API.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | String | | Polymarket market ID |
| question | String | | Market question |
| condition_id | String | | Blockchain condition ID |
| slug | String | | URL-friendly slug |
| resolution_source | String | | Source for resolution |
| end_date | DateTime | | Market end date |
| start_date | DateTime | | Market start date |
| created_at | DateTime | | Creation timestamp |
| submitted_by | String | | Creator address |
| resolved_by | String | | Resolver address |
| restricted | UInt8 | | Whether restricted |
| enable_order_book | UInt8 | | Orderbook enabled |
| order_price_min_tick_size | Float64 | | Minimum price tick |
| order_min_size | Float64 | | Minimum order size |
| clob_token_ids | String | | JSON array of token IDs |
| neg_risk | UInt8 | | Negative risk flag |
| neg_risk_market_id | String | | Neg risk market ID |
| neg_risk_request_id | String | | Neg risk request ID |
| inserted_at | DateTime | now() | Insertion timestamp |
| description | String | '' | Market description |
| category | String | '' | Market category |

**Engine:** ReplacingMergeTree (deduplicates by condition_id, id)

---

### market_events

Events associated with markets.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| event_id | String | | Event ID |
| market_id | String | | Foreign key to market_metadata.id |
| title | String | | Event title |
| inserted_at | DateTime | now() | Insertion timestamp |
| slug | String | '' | Event slug |
| description | String | '' | Event description |

**Engine:** ReplacingMergeTree (deduplicates by event_id, market_id)

---

## Views

### v_ob_bbo_1m

1-minute OHLC aggregation of BBO data.

| Column | Type | Description |
|--------|------|-------------|
| asset_id | String | Asset identifier |
| condition_id | String | Market condition ID |
| interval_1m | DateTime('UTC') | 1-minute interval start |
| open_bid | Decimal(38, 18) | Opening bid price |
| high_bid | Decimal(38, 18) | Highest bid price |
| low_bid | Decimal(38, 18) | Lowest bid price |
| close_bid | Decimal(38, 18) | Closing bid price |
| open_ask | Decimal(38, 18) | Opening ask price |
| high_ask | Decimal(38, 18) | Highest ask price |
| low_ask | Decimal(38, 18) | Lowest ask price |
| close_ask | Decimal(38, 18) | Closing ask price |
| open_mid | Decimal(38, 18) | Opening mid price |
| close_mid | Decimal(38, 18) | Closing mid price |
| vwap_mid | Decimal(38, 18) | Volume-weighted avg mid |
| avg_spread_bps | Float64 | Average spread (bps) |
| min_spread_bps | Float64 | Minimum spread (bps) |
| max_spread_bps | Float64 | Maximum spread (bps) |
| avg_bid_size | Float64 | Average bid size |
| avg_ask_size | Float64 | Average ask size |
| avg_imbalance | Float64 | Average book imbalance |
| tick_count | UInt64 | Number of ticks |
| first_ts | DateTime64(3, 'UTC') | First tick timestamp |
| last_ts | DateTime64(3, 'UTC') | Last tick timestamp |

---

### v_ob_bbo_5m

5-minute OHLC aggregation of BBO data. Same schema as v_ob_bbo_1m with `interval_5m` instead of `interval_1m`.

| Column | Type | Description |
|--------|------|-------------|
| asset_id | String | Asset identifier |
| condition_id | String | Market condition ID |
| interval_5m | DateTime('UTC') | 5-minute interval start |
| open_bid | Decimal(38, 18) | Opening bid price |
| high_bid | Decimal(38, 18) | Highest bid price |
| low_bid | Decimal(38, 18) | Lowest bid price |
| close_bid | Decimal(38, 18) | Closing bid price |
| open_ask | Decimal(38, 18) | Opening ask price |
| high_ask | Decimal(38, 18) | Highest ask price |
| low_ask | Decimal(38, 18) | Lowest ask price |
| close_ask | Decimal(38, 18) | Closing ask price |
| open_mid | Decimal(38, 18) | Opening mid price |
| close_mid | Decimal(38, 18) | Closing mid price |
| vwap_mid | Decimal(38, 18) | Volume-weighted avg mid |
| avg_spread_bps | Float64 | Average spread (bps) |
| min_spread_bps | Float64 | Minimum spread (bps) |
| max_spread_bps | Float64 | Maximum spread (bps) |
| avg_bid_size | Float64 | Average bid size |
| avg_ask_size | Float64 | Average ask size |
| avg_imbalance | Float64 | Average book imbalance |
| tick_count | UInt64 | Number of ticks |
| first_ts | DateTime64(3, 'UTC') | First tick timestamp |
| last_ts | DateTime64(3, 'UTC') | Last tick timestamp |

---

## Materialized Views

### trades_mv

Materialized view over raw trades for aggregation.

| Column | Type | Description |
|--------|------|-------------|
| market_source | String | Source exchange |
| market_type | String | Market type |
| id | String | Trade ID |
| transaction_hash | String | Transaction hash |
| order_hash | String | Order hash |
| timestamp | DateTime64(0) | Trade timestamp |
| maker | String | Maker address |
| taker | String | Taker address |
| maker_asset_id | String | Maker asset ID |
| taker_asset_id | String | Taker asset ID |
| side | String | Trade side |
| token_id | String | Token identifier |
| size_raw | UInt256 | Raw size |
| size | Float64 | Normalized size |
| usdc_volume_raw | UInt256 | Raw USDC volume |
| usdc_volume | Float64 | Normalized volume |
| price | Float64 | Trade price |
| fee_raw | UInt256 | Raw fee |
| fee_usdc | Float64 | Fee in USDC |
| chain_id | Int64 | Chain ID |

---

### makers_mv

Materialized view for maker aggregations.

| Column | Type | Description |
|--------|------|-------------|
| market_source | String | Source exchange |
| market_type | String | Market type |
| user | String | Maker address |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt8 | Trade count |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized volume |

---

### takers_mv

Materialized view for taker aggregations.

| Column | Type | Description |
|--------|------|-------------|
| market_source | String | Source exchange |
| market_type | String | Market type |
| user | String | Taker address |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt8 | Trade count |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized volume |

---

### markets_mv

Materialized view for market-level aggregations.

| Column | Type | Description |
|--------|------|-------------|
| market_source | String | Source exchange |
| market_type | String | Market type |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt64 | Total trade count |
| buys_count | UInt64 | Buy count |
| sells_count | UInt64 | Sell count |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized volume |
| shares_volume_raw | UInt64 | Raw shares volume |
| fees_raw | UInt64 | Raw fees |

---

### mv_ob_bbo_1m

Materialized view for 1-minute BBO aggregations. Populates the `v_ob_bbo_1m` view.

| Column | Type | Description |
|--------|------|-------------|
| asset_id | String | Asset identifier |
| condition_id | String | Market condition ID |
| interval_1m | DateTime('UTC') | 1-minute interval |
| open_bid | Decimal(38, 18) | Opening bid |
| high_bid | Decimal(38, 18) | High bid |
| low_bid | Decimal(38, 18) | Low bid |
| close_bid | Decimal(38, 18) | Closing bid |
| open_ask | Decimal(38, 18) | Opening ask |
| high_ask | Decimal(38, 18) | High ask |
| low_ask | Decimal(38, 18) | Low ask |
| close_ask | Decimal(38, 18) | Closing ask |
| open_mid | Decimal(38, 18) | Opening mid |
| close_mid | Decimal(38, 18) | Closing mid |
| vwap_mid | Decimal(38, 18) | VWAP mid |
| avg_spread_bps | Float64 | Avg spread (bps) |
| min_spread_bps | Float64 | Min spread (bps) |
| max_spread_bps | Float64 | Max spread (bps) |
| avg_bid_size | Float64 | Avg bid size |
| avg_ask_size | Float64 | Avg ask size |
| avg_imbalance | Float64 | Avg imbalance |
| tick_count | UInt64 | Tick count |
| first_ts | DateTime64(3, 'UTC') | First timestamp |
| last_ts | DateTime64(3, 'UTC') | Last timestamp |

---

### mv_ob_bbo_5m

Materialized view for 5-minute BBO aggregations. Same schema as mv_ob_bbo_1m with `interval_5m`.

---

### mv_ob_hourly_stats

Hourly orderbook statistics using AggregatingMergeTree.

| Column | Type | Description |
|--------|------|-------------|
| asset_id | String | Asset identifier |
| hour | DateTime('UTC') | Hour bucket |
| snapshot_count | AggregateFunction(count) | Snapshot count state |
| resync_count | AggregateFunction(count) | Resync count state |
| avg_spread_bps_state | AggregateFunction(avg, Float64) | Avg spread state |
| avg_mid_price_state | AggregateFunction(avg, Float64) | Avg mid price state |
| avg_bid_depth_state | AggregateFunction(avg, Float64) | Avg bid depth state |
| avg_ask_depth_state | AggregateFunction(avg, Float64) | Avg ask depth state |
| avg_imbalance_state | AggregateFunction(avg, Float64) | Avg imbalance state |

**Usage:** Query with `-Merge` functions:
```sql
SELECT
    asset_id,
    hour,
    countMerge(snapshot_count) as snapshots,
    avgMerge(avg_spread_bps_state) as avg_spread_bps
FROM mv_ob_hourly_stats
GROUP BY asset_id, hour
```

---

### mv_ob_latency_hourly

Materialized view for hourly latency percentiles using AggregatingMergeTree.

| Column | Type | Description |
|--------|------|-------------|
| hour | DateTime('UTC') | Hour bucket |
| p50_state | AggregateFunction(quantile(0.50), Float64) | P50 latency state |
| p95_state | AggregateFunction(quantile(0.95), Float64) | P95 latency state |
| p99_state | AggregateFunction(quantile(0.99), Float64) | P99 latency state |
| max_state | AggregateFunction(max, Float64) | Max latency state |
| count_state | AggregateFunction(count) | Sample count state |

**Engine:** AggregatingMergeTree
**Partition:** toYYYYMMDD(hour)
**Order:** hour
**TTL:** 7 days

**Usage:**
```sql
SELECT
    hour,
    quantileMerge(0.50)(p50_state) as p50_ms,
    quantileMerge(0.95)(p95_state) as p95_ms,
    quantileMerge(0.99)(p99_state) as p99_ms,
    maxMerge(max_state) as max_ms,
    countMerge(count_state) as samples
FROM trading_data.mv_ob_latency_hourly
WHERE hour >= NOW() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour;
```

---

## Common Patterns

### Multi-market Support

All trading and orderbook tables include:
- `market_source`: LowCardinality(String) DEFAULT 'polymarket'
- `market_type`: LowCardinality(String) DEFAULT 'prediction'

This enables future expansion to other markets while maintaining backward compatibility.

### Timestamp Precision

- `source_ts`: DateTime64(3) - Millisecond precision from exchange
- `ingestion_ts`: DateTime64(6) - Microsecond precision for our processing

### Price Precision

Price fields use `Decimal(38, 18)` or `Decimal128(18)` to avoid floating-point precision errors in financial calculations.

### Latency Tracking

Most tables include a materialized `latency_ms` column calculated as:
```sql
dateDiff('millisecond', source_ts, ingestion_ts)
```

## Raw Polymarket Database Tables

These tables are in the `raw_polymarket` database and contain data synced from The Graph subgraphs.

### global_open_interest

Global open interest tracking across all markets.

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Record identifier |
| amount | String | Open interest amount |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

---

### market_open_interest

Per-market open interest tracking.

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Market identifier |
| amount | String | Open interest amount |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

---

### order_filled

Individual order fill events from the CLOB.

| Column | Type | Description |
|--------|------|-------------|
| id | String | Fill event identifier |
| transaction_hash | Nullable(String) | Blockchain transaction hash |
| timestamp | String | Fill timestamp |
| order_hash | Nullable(String) | Original order hash |
| maker | String | Maker address |
| taker | String | Taker address |
| maker_asset_id | String | Maker's asset token ID |
| taker_asset_id | String | Taker's asset token ID |
| maker_amount_filled | String | Amount filled for maker |
| taker_amount_filled | String | Amount filled for taker |
| fee | String | Fee amount |
| chain_id | Int64 | Blockchain chain ID |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

---

### orders_matched

Matched order pair events.

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Match event identifier |
| timestamp | String | Match timestamp |
| maker_asset_id | String | Maker's asset token ID |
| taker_asset_id | String | Taker's asset token ID |
| maker_amount_filled | String | Amount filled for maker |
| taker_amount_filled | String | Amount filled for taker |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

---

### user_positions

User position tracking with PnL data.

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Position identifier |
| user | String | User wallet address |
| token_id | String | Token identifier |
| amount | String | Current position amount |
| avg_price | String | Average entry price |
| realized_pnl | String | Realized profit/loss |
| total_bought | String | Total amount bought |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |
