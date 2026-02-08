# ClickHouse Schema Reference

This document provides a complete reference for all ClickHouse tables used in the Polymarket Data Enrichment Pipeline.

**Last Updated:** After Cost Reduction Migration V2 (optimized types + compression)

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
- [Usage Tracking Tables](#usage-tracking-tables)
  - [usage_events](#usage_events)
- [Materialized Views](#materialized-views)
  - [trades_mv](#trades_mv)
  - [makers_mv](#makers_mv)
  - [takers_mv](#takers_mv)
  - [markets_mv](#markets_mv)
- [Raw Polymarket Database Tables](#raw-polymarket-database-tables)

---

## Schema Optimization Notes

This schema uses optimized data types for cost reduction:

| Original Type | Optimized Type | Savings |
|--------------|----------------|---------|
| Decimal128(18) | Decimal64(18) | 50% |
| Float64 | Float32 | 50% |
| DateTime64(6) | DateTime64(3) | 50% |
| String | LowCardinality(String) | 80%+ for low-cardinality |

All tables use **ZSTD compression** with Delta encoding for time-series columns.

---

## Trading Data Tables

### trades

Primary storage for raw trade execution data from Polymarket.

| Column | Type | Codec | Description |
|--------|------|-------|-------------|
| market_source | LowCardinality(String) | DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | DEFAULT 'prediction' | Market type |
| id | String | ZSTD(3) | Trade ID |
| transaction_hash | String | ZSTD(3) | Blockchain transaction hash |
| order_hash | String | ZSTD(3) | Order hash |
| timestamp | DateTime64(0, 'UTC') | Delta, ZSTD(1) | Trade execution time |
| maker | String | ZSTD(5) | Maker address |
| taker | String | ZSTD(5) | Taker address |
| maker_asset_id | LowCardinality(String) | ZSTD(5) | Maker's asset ID |
| taker_asset_id | LowCardinality(String) | ZSTD(5) | Taker's asset ID |
| token_id | LowCardinality(String) | ZSTD(5) | Token identifier |
| size | Float32 | ZSTD(3) | Normalized size |
| usdc_volume | Float32 | ZSTD(3) | Normalized USDC volume |
| price | Float32 | ZSTD(3) | Execution price |
| fee_usdc | Float32 | ZSTD(3) | Fee in USDC |
| side | LowCardinality(String) | | Trade side (BUY/SELL) |

**Engine:** MergeTree()
**Partition By:** toYYYYMM(timestamp)
**Order By:** (token_id, timestamp, id)
**TTL:** 365 days

---

### trade_ticks

Lightweight trade tick data for time-series analysis with millisecond precision.

| Column | Type | Codec | Description |
|--------|------|-------|-------------|
| market_source | LowCardinality(String) | DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | DEFAULT 'prediction' | Market type |
| asset_id | LowCardinality(String) | ZSTD(5) | Asset identifier |
| condition_id | LowCardinality(String) | ZSTD(5) | Market condition ID |
| trade_id | String | ZSTD(3) | Trade identifier |
| source_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Exchange timestamp (ms) |
| ingestion_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Ingestion timestamp (ms) |
| price | Decimal64(18) | ZSTD(3) | Trade price |
| size | Float32 | ZSTD(3) | Trade size |
| side | LowCardinality(String) | | Trade side |
| latency_ms | Float32 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |
| notional | Float32 | MATERIALIZED | `toFloat32(price) * size` |

**Engine:** MergeTree()
**Partition By:** toYYYYMM(source_ts)
**Order By:** (asset_id, source_ts, trade_id)
**TTL:** 365 days

---

### makers

Aggregated maker activity by user and token. Populated by `makers_mv` from trades.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) DEFAULT 'prediction' | Market type |
| user | String | Maker address |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt64 | Number of trades |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |

**Engine:** SummingMergeTree()

---

### takers

Aggregated taker activity by user and token. Populated by `takers_mv` from trades.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) DEFAULT 'prediction' | Market type |
| user | String | Taker address |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt64 | Number of trades |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |

**Engine:** SummingMergeTree()

---

### markets

Aggregated market-level trading statistics. Populated by `markets_mv` from trades.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) DEFAULT 'prediction' | Market type |
| token_id | String | Token identifier |
| timestamp | DateTime | Aggregation timestamp |
| trades_count | UInt64 | Total trade count |
| buys_count | UInt64 | Buy trade count |
| sells_count | UInt64 | Sell trade count |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |
| shares_volume_raw | UInt64 | Raw shares volume |
| fees_raw | UInt64 | Raw fees collected |

**Engine:** SummingMergeTree()

---

## Orderbook Tables

### ob_bbo

Best Bid/Offer (top-of-book) tick data. Lightweight alternative to full L2 snapshots (~20-50x smaller).

| Column | Type | Codec | Description |
|--------|------|-------|-------------|
| market_source | LowCardinality(String) | DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | DEFAULT 'prediction' | Market type |
| asset_id | LowCardinality(String) | ZSTD(5) | Asset identifier |
| condition_id | LowCardinality(String) | ZSTD(5) | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | Delta(8), ZSTD(1) | Polymarket timestamp |
| ingestion_ts | DateTime64(3, 'UTC') | Delta(8), ZSTD(1) | Our receipt timestamp |
| book_hash | String | ZSTD(1) | Hash for dedup/gap detection |
| best_bid | Decimal(18, 18) | ZSTD(3) | Best bid price |
| best_ask | Decimal(18, 18) | ZSTD(3) | Best ask price |
| bid_size | Float32 | ZSTD(3) | Size at best bid |
| ask_size | Float32 | ZSTD(3) | Size at best ask |
| mid_price | Decimal(18, 18) | ZSTD(3) | Mid price (legacy, to be removed) |
| spread_bps | Float32 | ZSTD(3) | Spread in basis points |
| tick_size | Decimal(18, 18) | ZSTD(3) | Price tick size |
| is_resync | UInt8 | DEFAULT 0 | 1 if from gap backfill |
| sequence_number | UInt64 | Delta(8), ZSTD(1) | Sequence for ordering |
| neg_risk | UInt8 | DEFAULT 0 | Negative risk flag |
| order_min_size | Float32 | ZSTD(3) | Minimum order size |
| spread | Decimal(18, 18) | MATERIALIZED | `best_ask - best_bid` |
| latency_ms | Float32 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |

**Engine:** MergeTree()
**Partition By:** toYYYYMM(source_ts)
**Order By:** (asset_id, source_ts, ingestion_ts)
**TTL:** 365 days

---

### ob_snapshots

Full L2 orderbook snapshots with depth arrays. Optimized schema with reduced materialized columns.

| Column | Type | Codec | Description |
|--------|------|-------|-------------|
| market_source | LowCardinality(String) | DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | DEFAULT 'prediction' | Market type |
| asset_id | LowCardinality(String) | ZSTD(5) | Asset identifier |
| condition_id | LowCardinality(String) | ZSTD(5) | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Polymarket timestamp |
| ingestion_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Our receipt timestamp |
| book_hash | String | ZSTD(1) | Hash for dedup/gap detection |
| bid_prices | Array(Decimal64(18)) | ZSTD(5) | Bid price levels |
| bid_sizes | Array(Float32) | ZSTD(5) | Sizes at each bid level |
| ask_prices | Array(Decimal64(18)) | ZSTD(5) | Ask price levels |
| ask_sizes | Array(Float32) | ZSTD(5) | Sizes at each ask level |
| tick_size | Decimal64(18) | ZSTD(3) | Price tick size |
| is_resync | UInt8 | DEFAULT 0 | 1 if from gap backfill |
| sequence_number | UInt64 | Delta, ZSTD(1) | Sequence for ordering |
| neg_risk | UInt8 | DEFAULT 0 | Negative risk flag |
| order_min_size | Float32 | DEFAULT 0 | Minimum order size |
| best_bid | Decimal64(18) | MATERIALIZED | First bid price |
| best_ask | Decimal64(18) | MATERIALIZED | First ask price |

**Removed Materialized Columns** (compute in queries instead):
- `mid_price` → `(best_bid + best_ask) / 2`
- `spread` → `best_ask - best_bid`
- `spread_bps` → `toFloat64((best_ask - best_bid) / ((best_bid + best_ask) / 2)) * 10000`
- `total_bid_depth` → `arraySum(bid_sizes)`
- `total_ask_depth` → `arraySum(ask_sizes)`
- `bid_levels` → `length(bid_prices)`
- `ask_levels` → `length(ask_prices)`
- `book_imbalance` → `(arraySum(bid_sizes) - arraySum(ask_sizes)) / (arraySum(bid_sizes) + arraySum(ask_sizes))`

**Engine:** MergeTree()
**Partition By:** toYYYYMM(source_ts)
**Order By:** (asset_id, source_ts, ingestion_ts)
**TTL:** 365 days
**Index:** bloom_filter on book_hash

---

### ob_level_changes

Order book level changes tracking placements and cancellations at each price level.

| Column | Type | Codec | Description |
|--------|------|-------|-------------|
| market_source | LowCardinality(String) | DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) | DEFAULT 'prediction' | Market type |
| asset_id | LowCardinality(String) | ZSTD(5) | Asset identifier |
| condition_id | LowCardinality(String) | ZSTD(5) | Market condition ID |
| source_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Polymarket timestamp |
| ingestion_ts | DateTime64(3, 'UTC') | Delta, ZSTD(1) | Our receipt timestamp |
| side | LowCardinality(String) | | 'BUY' or 'SELL' |
| price | Decimal64(18) | ZSTD(3) | Price level |
| old_size | Float32 | ZSTD(3) | Previous size at level |
| new_size | Float32 | ZSTD(3) | New size at level |
| size_delta | Float32 | ZSTD(3) | `new_size - old_size` |
| change_type | LowCardinality(String) | | 'ADD', 'REMOVE', 'UPDATE' |
| book_hash | String | ZSTD(1) | Book state hash |
| sequence_number | UInt64 | Delta, ZSTD(1) | Sequence for ordering |
| latency_ms | Float32 | MATERIALIZED | `dateDiff('millisecond', source_ts, ingestion_ts)` |

**Engine:** MergeTree()
**Partition By:** toYYYYMM(source_ts)
**Order By:** (asset_id, source_ts, sequence_number)
**TTL:** 14 days
**Index:** set(3) on change_type

---

### ob_gap_events

Gap detection audit log for orderbook data integrity.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) DEFAULT 'polymarket' | Source exchange |
| market_type | LowCardinality(String) DEFAULT 'prediction' | Market type |
| asset_id | String | Asset identifier |
| detected_at | DateTime64(6, 'UTC') | Detection timestamp |
| last_known_hash | String | Last seen book hash |
| new_hash | String | New book hash after gap |
| gap_duration_ms | Float64 | Gap duration in ms |
| resolution | String | Gap resolution status |

---

### ob_latency

Ingestion latency metrics for monitoring.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) | Source exchange |
| market_type | LowCardinality(String) | Market type |
| asset_id | String | Asset identifier |
| source_ts | DateTime64(3, 'UTC') | Polymarket timestamp |
| ingestion_ts | DateTime64(6, 'UTC') | Our receipt timestamp |
| latency_ms | Float64 | MATERIALIZED latency |
| event_type | LowCardinality(String) | Event type |

**TTL:** 7 days

---

## Market Metadata Tables

### market_metadata

Core market information from the Gamma API.

| Column | Type | Description |
|--------|------|-------------|
| id | String | Polymarket market ID |
| question | String | Market question |
| condition_id | String | Blockchain condition ID |
| slug | String | URL-friendly slug |
| resolution_source | String | Source for resolution |
| end_date | DateTime | Market end date |
| start_date | DateTime | Market start date |
| created_at | DateTime | Creation timestamp |
| submitted_by | String | Creator address |
| resolved_by | String | Resolver address |
| restricted | UInt8 | Whether restricted |
| enable_order_book | UInt8 | Orderbook enabled |
| order_price_min_tick_size | Float64 | Minimum price tick |
| order_min_size | Float64 | Minimum order size |
| clob_token_ids | String | JSON array of token IDs |
| neg_risk | UInt8 | Negative risk flag |
| neg_risk_market_id | String | Neg risk market ID |
| neg_risk_request_id | String | Neg risk request ID |
| inserted_at | DateTime DEFAULT now() | Record insertion timestamp |
| description | String DEFAULT '' | Market description |
| category | String DEFAULT '' | Market category |

**Engine:** ReplacingMergeTree()
**Order By:** (condition_id, id)

---

### market_events

Events associated with markets.

| Column | Type | Description |
|--------|------|-------------|
| event_id | String | Event ID |
| market_id | String | Foreign key to market_metadata.id |
| title | String | Event title |
| inserted_at | DateTime DEFAULT now() | Record insertion timestamp |
| slug | String DEFAULT '' | Event slug |
| description | String DEFAULT '' | Event description |

**Engine:** ReplacingMergeTree()
**Order By:** (event_id, market_id)

---

## Usage Tracking Tables

### usage_events

API usage tracking for billing and analytics.

| Column | Type | Description |
|--------|------|-------------|
| api_key_hash | String | Hashed API key |
| tier | LowCardinality(String) | User tier level |
| endpoint | String | API endpoint called |
| rows_returned | UInt64 | Number of rows returned |
| timestamp | DateTime64(3, 'UTC') | Event timestamp |
| billing_cycle | String | Billing cycle identifier |

---

## Materialized Views

### trades_mv

Transforms raw blockchain data from `raw_polymarket.order_filled` into the `trades` table.

| Column | Type | Description |
|--------|------|-------------|
| market_source | String | Source exchange ('polymarket') |
| market_type | String | Market type ('prediction') |
| id | String | Trade ID |
| transaction_hash | Nullable(String) | Blockchain transaction hash |
| order_hash | Nullable(String) | Order hash |
| timestamp | DateTime64(0, 'UTC') | Trade execution time |
| maker | String | Maker address |
| taker | String | Taker address |
| maker_asset_id | String | Maker's asset ID |
| taker_asset_id | String | Taker's asset ID |
| token_id | String | Token identifier |
| size | Float32 | Normalized size |
| usdc_volume | Float32 | Normalized USDC volume |
| price | Float32 | Execution price |
| fee_usdc | Float32 | Fee in USDC |
| side | String | Trade side (BUY/SELL) |

**Source:** `raw_polymarket.order_filled`
**Target:** `trading_data.trades`

---

### makers_mv

Aggregates maker activity from trades into the `makers` table.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) | Source exchange |
| market_type | LowCardinality(String) | Market type |
| user | String | Maker address |
| token_id | LowCardinality(String) | Token identifier |
| timestamp | DateTime('UTC') | Aggregation timestamp (minute bucket) |
| trades_count | UInt64 | Trade count (1 per row) |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |

**Source:** `trading_data.trades`
**Target:** `trading_data.makers`

---

### takers_mv

Aggregates taker activity from trades into the `takers` table.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) | Source exchange |
| market_type | LowCardinality(String) | Market type |
| user | String | Taker address |
| token_id | LowCardinality(String) | Token identifier |
| timestamp | DateTime('UTC') | Aggregation timestamp (minute bucket) |
| trades_count | UInt64 | Trade count (1 per row) |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |

**Source:** `trading_data.trades`
**Target:** `trading_data.takers`

---

### markets_mv

Aggregates market-level statistics from trades into the `markets` table.

| Column | Type | Description |
|--------|------|-------------|
| market_source | LowCardinality(String) | Source exchange |
| market_type | LowCardinality(String) | Market type |
| token_id | LowCardinality(String) | Token identifier |
| timestamp | DateTime('UTC') | Aggregation timestamp (minute bucket) |
| trades_count | UInt64 | Total trade count |
| buys_count | LowCardinality(UInt64) | Buy count |
| sells_count | LowCardinality(UInt64) | Sell count |
| usdc_volume_raw | UInt64 | Raw USDC volume |
| usdc_volume | Float64 | Normalized USDC volume |
| shares_volume_raw | UInt64 | Raw shares volume |
| fees_raw | UInt64 | Raw fees |

**Source:** `trading_data.trades`
**Target:** `trading_data.markets`

---

### Data Flow

```
raw_polymarket.order_filled
         │
         ▼
    trades_mv ──────► trades
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    makers_mv       takers_mv       markets_mv
         │               │               │
         ▼               ▼               ▼
      makers          takers          markets
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
- `ingestion_ts`: DateTime64(3) - Millisecond precision for our processing

**Note:** Reduced from microsecond (6) to millisecond (3) precision for 50% storage savings. Microsecond precision is not needed for trading data analysis.

### Price Precision

Price fields use `Decimal64(18)` for:
- Sufficient precision for all Polymarket prices (0-1 range)
- 50% storage savings vs Decimal128(18)
- No floating-point precision errors

**Note:** Decimal64(18) supports values up to ~9.2 quintillion with 18 decimal places.

### Latency Tracking

Most tables include a materialized `latency_ms` column calculated as:
```sql
dateDiff('millisecond', source_ts, ingestion_ts)
```

### Compression Codecs

All high-volume tables use:
- `ZSTD(3-5)` for string and numeric columns
- `Delta, ZSTD(1)` for timestamp and sequence columns
- Higher ZSTD levels (5) for low-entropy data like asset_id

---

## Raw Polymarket Database Tables

These tables are in the `raw_polymarket` database and contain data synced from The Graph subgraphs.

### global_open_interest

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Record identifier |
| amount | String | Open interest amount |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

### market_open_interest

| Column | Type | Description |
|--------|------|-------------|
| vid | Int64 | Version ID |
| block_range | String | Block range for versioning |
| id | String | Market identifier |
| amount | String | Open interest amount |
| _gs_chain | String | Graph sync chain identifier |
| _gs_gid | String | Graph sync global ID |
| is_deleted | UInt8 | Soft delete flag |

### order_filled

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

### orders_matched

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

### user_positions

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
