-- ============================================================
-- ORDERBOOK TABLES - New tables for L2 orderbook data
-- Run these AFTER your existing schema is in place
-- ============================================================

-- L2 Orderbook Snapshots
-- Primary storage for orderbook state over time
-- NOTE: Uses Decimal128(18) for price data to avoid floating-point precision errors
-- NOTE: market_source must match src/core/enums.ts::MarketSource type
--       Currently supported: 'polymarket'
-- NOTE: market_type must match src/core/enums.ts::MarketType type
--       Currently supported: 'prediction'
CREATE TABLE IF NOT EXISTS trading_data.ob_snapshots (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    condition_id String,
    source_ts DateTime64(3, 'UTC'),      -- Polymarket's timestamp
    ingestion_ts DateTime64(6, 'UTC'),   -- Our receipt timestamp (microseconds)
    book_hash String,                     -- For dedup and gap detection

    -- L2 depth as arrays (Decimal128 for price precision, Float64 for sizes)
    bid_prices Array(Decimal128(18)),
    bid_sizes Array(Float64),
    ask_prices Array(Decimal128(18)),
    ask_sizes Array(Float64),

    tick_size Decimal128(18),
    is_resync UInt8 DEFAULT 0,           -- 1 if from gap backfill
    sequence_number UInt64,

    -- Market metadata (from market_metadata table, matched on condition_id)
    neg_risk UInt8 DEFAULT 0,            -- Negative risk market flag
    order_min_size Float64 DEFAULT 0,    -- Minimum order size for this market

    -- Materialized metrics (must only reference base columns, not other materialized columns)
    best_bid Decimal128(18) MATERIALIZED if(length(bid_prices) > 0, bid_prices[1], toDecimal128(0, 18)),
    best_ask Decimal128(18) MATERIALIZED if(length(ask_prices) > 0, ask_prices[1], toDecimal128(0, 18)),
    mid_price Decimal128(18) MATERIALIZED if(
        length(bid_prices) > 0 AND length(ask_prices) > 0,
        (bid_prices[1] + ask_prices[1]) / 2,
        toDecimal128(0, 18)
    ),
    spread Decimal128(18) MATERIALIZED if(
        length(ask_prices) > 0 AND length(bid_prices) > 0,
        ask_prices[1] - bid_prices[1],
        toDecimal128(0, 18)
    ),
    spread_bps Float64 MATERIALIZED if(
        length(bid_prices) > 0 AND length(ask_prices) > 0 AND (bid_prices[1] + ask_prices[1]) > toDecimal128(0, 18),
        toFloat64((ask_prices[1] - bid_prices[1]) / ((bid_prices[1] + ask_prices[1]) / 2)) * 10000,
        0
    ),

    -- Depth aggregates
    total_bid_depth Float64 MATERIALIZED arraySum(bid_sizes),
    total_ask_depth Float64 MATERIALIZED arraySum(ask_sizes),
    bid_levels UInt16 MATERIALIZED toUInt16(length(bid_prices)),
    ask_levels UInt16 MATERIALIZED toUInt16(length(ask_prices)),

    -- Imbalance (must reference base columns)
    book_imbalance Float64 MATERIALIZED if(
        arraySum(bid_sizes) + arraySum(ask_sizes) > 0,
        (arraySum(bid_sizes) - arraySum(ask_sizes)) / (arraySum(bid_sizes) + arraySum(ask_sizes)),
        0
    )
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(source_ts)
ORDER BY (asset_id, source_ts, ingestion_ts)
TTL source_ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Index for hash lookups (gap detection queries)
ALTER TABLE trading_data.ob_snapshots ADD INDEX IF NOT EXISTS idx_book_hash book_hash TYPE bloom_filter GRANULARITY 4;


-- Gap Detection Audit Log
-- NOTE: market_source/market_type values must match src/core/enums.ts types
CREATE TABLE IF NOT EXISTS trading_data.ob_gap_events (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    detected_at DateTime64(3, 'UTC'),
    last_known_hash String,
    new_hash String,
    gap_duration_ms UInt64,
    resolution Enum8('PENDING' = 0, 'RESOLVED' = 1, 'FAILED' = 2) DEFAULT 'PENDING',
    resolved_at Nullable(DateTime64(3, 'UTC')),
    snapshots_recovered UInt32 DEFAULT 0
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(detected_at)
ORDER BY (asset_id, detected_at);


-- Ingestion Latency Metrics
-- NOTE: market_source/market_type values must match src/core/enums.ts types
CREATE TABLE IF NOT EXISTS trading_data.ob_latency (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    source_ts DateTime64(3, 'UTC'),
    ingestion_ts DateTime64(6, 'UTC'),
    latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts),
    event_type LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(source_ts)
ORDER BY (source_ts, asset_id)
TTL source_ts + INTERVAL 7 DAY;


-- Hourly Orderbook Statistics (Materialized View)
-- NOTE: Uses AggregatingMergeTree with State functions for correct aggregation on merge.
-- Query with: SELECT asset_id, hour, countMerge(snapshot_count), avgMerge(avg_spread_bps_state), ...
-- SummingMergeTree would corrupt avg() results by summing averages during part merges.
CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_hourly_stats
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (asset_id, hour)
AS
SELECT
    asset_id,
    toStartOfHour(source_ts) as hour,
    countState() as snapshot_count,
    countStateIf(is_resync = 1) as resync_count,
    avgState(spread_bps) as avg_spread_bps_state,
    avgState(mid_price) as avg_mid_price_state,
    avgState(total_bid_depth) as avg_bid_depth_state,
    avgState(total_ask_depth) as avg_ask_depth_state,
    avgState(book_imbalance) as avg_imbalance_state
FROM trading_data.ob_snapshots
GROUP BY asset_id, hour;


-- Latency Percentiles View
CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_latency_hourly
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMMDD(hour)
ORDER BY hour
TTL hour + INTERVAL 7 DAY
AS
SELECT
    toStartOfHour(source_ts) as hour,
    quantileState(0.50)(latency_ms) as p50_state,
    quantileState(0.95)(latency_ms) as p95_state,
    quantileState(0.99)(latency_ms) as p99_state,
    maxState(latency_ms) as max_state,
    countState() as count_state
FROM trading_data.ob_latency
GROUP BY hour;


-- ============================================================
-- BBO (Best Bid/Offer) TABLE - Lightweight tick storage
-- ~20-50x smaller than full L2 snapshots
-- ============================================================

-- Main BBO table (target for buffer flush)
-- NOTE: Uses Decimal128(18) for price data to avoid floating-point precision errors
-- NOTE: market_source/market_type values must match src/core/enums.ts types
CREATE TABLE IF NOT EXISTS trading_data.ob_bbo (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    condition_id String,
    source_ts DateTime64(3, 'UTC'),
    ingestion_ts DateTime64(6, 'UTC'),
    book_hash String,

    -- Top-of-book only (Decimal128 for price precision, Float64 for sizes)
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

    -- Materialized spread for queries
    spread Decimal128(18) MATERIALIZED best_ask - best_bid,

    -- Latency materialized
    latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(source_ts)
ORDER BY (asset_id, source_ts, ingestion_ts)
TTL source_ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;


-- ============================================================
-- ORDER BOOK LEVEL CHANGES - Track placements and cancellations
-- Captures every add/remove/update event at each price level
-- ============================================================

-- NOTE: market_source/market_type values must match src/core/enums.ts types
CREATE TABLE IF NOT EXISTS trading_data.ob_level_changes (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    condition_id String,
    source_ts DateTime64(3, 'UTC'),
    ingestion_ts DateTime64(6, 'UTC'),

    -- Level change details
    side LowCardinality(String),              -- 'BUY' or 'SELL'
    price Decimal128(18),
    old_size Float64,
    new_size Float64,
    size_delta Float64,                       -- new_size - old_size (negative for cancellations)
    change_type LowCardinality(String),       -- 'ADD', 'REMOVE', 'UPDATE'
    book_hash String,
    sequence_number UInt64,

    -- Materialized latency for monitoring
    latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(source_ts)
ORDER BY (asset_id, source_ts, sequence_number)
TTL source_ts + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Index for change type analysis
ALTER TABLE trading_data.ob_level_changes ADD INDEX IF NOT EXISTS idx_change_type change_type TYPE set(3) GRANULARITY 4;


-- ============================================================
-- NOTE: Buffer tables are NO LONGER USED
-- We now use ClickHouse Async Inserts instead, which provide:
-- - Same CPU reduction benefits (server-side batching)
-- - Better reliability (acknowledged writes, no memory-only data)
-- - Simpler architecture (no separate buffer tables to manage)
-- - Automatic schema adaptation
--
-- Async inserts are enabled via URL parameters:
--   ?async_insert=1&wait_for_async_insert=1
-- ============================================================


-- ============================================================
-- DEAD LETTER MESSAGES - Failed queue messages for debugging
-- Stores messages that failed processing after max retries
-- ============================================================

-- NOTE: market_source/market_type values must match src/core/enums.ts types
CREATE TABLE IF NOT EXISTS trading_data.dead_letter_messages (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    original_queue LowCardinality(String),
    message_type LowCardinality(String),  -- 'bbo_snapshot', 'gap_backfill', etc.
    payload String,                        -- JSON serialized original message
    error String,
    failed_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    retry_count UInt8
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(failed_at)
ORDER BY (original_queue, message_type, failed_at)
TTL failed_at + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Index for debugging by error message
ALTER TABLE trading_data.dead_letter_messages ADD INDEX IF NOT EXISTS idx_error error TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;


-- ============================================================
-- MARKET METADATA - Market info from Gamma API
-- Used for joining with orderbook data to get market context
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.market_metadata (
    id String,
    question String,
    condition_id String,
    slug String,
    resolution_source String,
    end_date DateTime64(3, 'UTC'),
    start_date DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC'),
    submitted_by String,
    resolved_by String,
    restricted UInt8,
    enable_order_book UInt8,
    order_price_min_tick_size Float64,
    order_min_size Float64,
    clob_token_ids String,              -- JSON array of token IDs
    neg_risk UInt8,
    neg_risk_market_id String,
    neg_risk_request_id String,
    description String DEFAULT '',           -- Market description (contains resolution criteria)
    category String DEFAULT ''               -- Market category (e.g., "Politics", "Sports")
)
ENGINE = ReplacingMergeTree()
ORDER BY (condition_id, id);


-- ============================================================
-- MARKET EVENTS - Event metadata linked to markets
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.market_events (
    event_id String,
    market_id String,
    title String,
    -- For dependency graph building
    slug String DEFAULT '',
    description String DEFAULT ''
)
ENGINE = ReplacingMergeTree()
ORDER BY (event_id, market_id);


-- ============================================================
-- ARCHIVE LOG - Tracks data archival operations to R2
-- Records what data has been archived and where
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.archive_log (
    condition_id String,                      -- Market condition ID (empty for aged archives)
    archive_type LowCardinality(String),      -- 'resolved' or 'aged'
    table_name LowCardinality(String),        -- Source table name
    r2_path String,                           -- Full R2 object path
    rows_archived UInt64,                     -- Number of rows in archive
    min_source_ts DateTime64(3, 'UTC'),       -- Earliest timestamp in archive
    max_source_ts DateTime64(3, 'UTC'),       -- Latest timestamp in archive
    archived_at DateTime64(3, 'UTC'),         -- When archival occurred
    clickhouse_deleted UInt8 DEFAULT 0        -- 1 if data has been deleted from CH
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(archived_at)
ORDER BY (condition_id, table_name, archived_at);

-- Index for finding archives by type
ALTER TABLE trading_data.archive_log ADD INDEX IF NOT EXISTS idx_archive_type archive_type TYPE set(2) GRANULARITY 4;


-- ============================================================
-- USAGE EVENTS - Tracks API usage for billing
-- Records rows returned per request for tier-based billing
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.usage_events (
    api_key_hash String,                      -- Hashed API key (privacy)
    tier LowCardinality(String),              -- Data tier: starter, pro, team, business
    endpoint String,                          -- API endpoint path
    rows_returned UInt64,                     -- Number of rows in response
    timestamp DateTime64(3, 'UTC'),           -- Request timestamp
    billing_cycle String                      -- YYYY-MM format for billing period
)
ENGINE = MergeTree()
PARTITION BY billing_cycle
ORDER BY (api_key_hash, timestamp)
TTL timestamp + INTERVAL 365 DAY;

-- Index for billing queries
ALTER TABLE trading_data.usage_events ADD INDEX IF NOT EXISTS idx_billing_cycle billing_cycle TYPE set(100) GRANULARITY 4;


-- ============================================================
-- 1-MINUTE BBO MATERIALIZED VIEW - Aggregated tick data for backtesting
-- Provides OHLC-style data at 1-minute granularity
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_bbo_1m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (asset_id, minute)
AS
SELECT
    asset_id,
    toStartOfMinute(source_ts) AS minute,
    -- Open/Close using argMin/argMax state functions
    argMinState(best_bid, source_ts) AS open_bid_state,
    argMaxState(best_bid, source_ts) AS close_bid_state,
    argMinState(best_ask, source_ts) AS open_ask_state,
    argMaxState(best_ask, source_ts) AS close_ask_state,
    -- Spread statistics
    avgState(spread_bps) AS avg_spread_bps_state,
    maxState(spread_bps) AS max_spread_bps_state,
    minState(spread_bps) AS min_spread_bps_state,
    -- Volume and count
    countState() AS tick_count_state,
    -- Sequence tracking
    minState(sequence_number) AS sequence_start_state,
    maxState(sequence_number) AS sequence_end_state
FROM trading_data.ob_bbo
GROUP BY asset_id, minute;


-- ============================================================
-- 5-MINUTE BBO MATERIALIZED VIEW - Coarser aggregation
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_bbo_5m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (asset_id, minute)
AS
SELECT
    asset_id,
    toStartOfFiveMinutes(source_ts) AS minute,
    argMinState(best_bid, source_ts) AS open_bid_state,
    argMaxState(best_bid, source_ts) AS close_bid_state,
    argMinState(best_ask, source_ts) AS open_ask_state,
    argMaxState(best_ask, source_ts) AS close_ask_state,
    avgState(spread_bps) AS avg_spread_bps_state,
    countState() AS tick_count_state,
    minState(sequence_number) AS sequence_start_state,
    maxState(sequence_number) AS sequence_end_state
FROM trading_data.ob_bbo
GROUP BY asset_id, minute;


-- ============================================================
-- TRADE TICKS - Execution-level trade data
-- Stores individual trade executions for backtesting
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.trade_ticks (
    market_source LowCardinality(String) DEFAULT 'polymarket',
    market_type LowCardinality(String) DEFAULT 'prediction',
    asset_id String,
    condition_id String,
    source_ts DateTime64(3, 'UTC'),           -- Trade timestamp from exchange
    ingestion_ts DateTime64(6, 'UTC'),        -- Our receipt timestamp

    -- Trade details
    trade_id String,
    price Decimal128(18),
    size Float64,
    side LowCardinality(String),              -- 'BUY' or 'SELL'
    maker_order_id String DEFAULT '',
    taker_order_id String DEFAULT '',

    -- Book state at trade time
    book_hash String DEFAULT '',
    sequence_number UInt64 DEFAULT 0,

    -- Materialized fields
    notional Float64 MATERIALIZED toFloat64(price) * size,
    latency_ms Float64 MATERIALIZED dateDiff('millisecond', source_ts, ingestion_ts)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(source_ts)
ORDER BY (asset_id, source_ts, trade_id)
TTL source_ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Index for trade lookups
ALTER TABLE trading_data.trade_ticks ADD INDEX IF NOT EXISTS idx_trade_id trade_id TYPE bloom_filter GRANULARITY 4;
