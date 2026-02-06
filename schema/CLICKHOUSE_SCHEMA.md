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
- [Market Metadata Tables](#market-metadata-tables)
  - [market_metadata](#market_metadata)
  - [market_events](#market_events)
- [Materialized Views](#materialized-views)
  - [trades_mv](#trades_mv)
  - [makers_mv](#makers_mv)
  - [takers_mv](#takers_mv)
  - [markets_mv](#markets_mv)
  - [mv_ob_hourly_stats](#mv_ob_hourly_stats)
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

**TTL:** 365 days (backtesting retention)

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

**TTL:** 365 days (backtesting retention)

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

**TTL:** 14 days (operational)

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
