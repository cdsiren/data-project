-- ============================================================
-- ORDERBOOK TABLES - New tables for L2 orderbook data
-- Run these AFTER your existing schema is in place
-- ============================================================

-- L2 Orderbook Snapshots
-- Primary storage for orderbook state over time
-- NOTE: Uses Decimal128(18) for price data to avoid floating-point precision errors
CREATE TABLE IF NOT EXISTS polymarket.ob_snapshots (
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
ALTER TABLE polymarket.ob_snapshots ADD INDEX IF NOT EXISTS idx_book_hash book_hash TYPE bloom_filter GRANULARITY 4;


-- Gap Detection Audit Log
CREATE TABLE IF NOT EXISTS polymarket.ob_gap_events (
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
CREATE TABLE IF NOT EXISTS polymarket.ob_latency (
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
CREATE MATERIALIZED VIEW IF NOT EXISTS polymarket.mv_ob_hourly_stats
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
FROM polymarket.ob_snapshots
GROUP BY asset_id, hour;


-- Latency Percentiles View
CREATE MATERIALIZED VIEW IF NOT EXISTS polymarket.mv_ob_latency_hourly
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
FROM polymarket.ob_latency
GROUP BY hour;


-- ============================================================
-- BBO (Best Bid/Offer) TABLE - Lightweight tick storage
-- ~20-50x smaller than full L2 snapshots
-- ============================================================

-- Main BBO table (target for buffer flush)
-- NOTE: Uses Decimal128(18) for price data to avoid floating-point precision errors
CREATE TABLE IF NOT EXISTS polymarket.ob_bbo (
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

CREATE TABLE IF NOT EXISTS polymarket.ob_level_changes (
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
ALTER TABLE polymarket.ob_level_changes ADD INDEX IF NOT EXISTS idx_change_type change_type TYPE set(3) GRANULARITY 4;


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

CREATE TABLE IF NOT EXISTS polymarket.dead_letter_messages (
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
ALTER TABLE polymarket.dead_letter_messages ADD INDEX IF NOT EXISTS idx_error error TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;
