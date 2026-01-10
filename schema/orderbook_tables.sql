-- ============================================================
-- ORDERBOOK TABLES - New tables for L2 orderbook data
-- Run these AFTER your existing schema is in place
-- ============================================================

-- L2 Orderbook Snapshots
-- Primary storage for orderbook state over time
CREATE TABLE IF NOT EXISTS polymarket.ob_snapshots (
    asset_id String,
    condition_id String,
    source_ts DateTime64(3, 'UTC'),      -- Polymarket's timestamp
    ingestion_ts DateTime64(6, 'UTC'),   -- Our receipt timestamp (microseconds)
    book_hash String,                     -- For dedup and gap detection

    -- L2 depth as arrays
    bid_prices Array(Float64),
    bid_sizes Array(Float64),
    ask_prices Array(Float64),
    ask_sizes Array(Float64),

    tick_size Float64,
    is_resync UInt8 DEFAULT 0,           -- 1 if from gap backfill
    sequence_number UInt64,

    -- Materialized metrics (must only reference base columns, not other materialized columns)
    best_bid Float64 MATERIALIZED if(length(bid_prices) > 0, bid_prices[1], 0),
    best_ask Float64 MATERIALIZED if(length(ask_prices) > 0, ask_prices[1], 0),
    mid_price Float64 MATERIALIZED if(
        length(bid_prices) > 0 AND length(ask_prices) > 0,
        (bid_prices[1] + ask_prices[1]) / 2,
        0
    ),
    spread Float64 MATERIALIZED if(
        length(ask_prices) > 0 AND length(bid_prices) > 0,
        ask_prices[1] - bid_prices[1],
        0
    ),
    spread_bps Float64 MATERIALIZED if(
        length(bid_prices) > 0 AND length(ask_prices) > 0 AND (bid_prices[1] + ask_prices[1]) > 0,
        ((ask_prices[1] - bid_prices[1]) / ((bid_prices[1] + ask_prices[1]) / 2)) * 10000,
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
CREATE MATERIALIZED VIEW IF NOT EXISTS polymarket.mv_ob_hourly_stats
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (asset_id, hour)
AS
SELECT
    asset_id,
    toStartOfHour(source_ts) as hour,
    count() as snapshot_count,
    countIf(is_resync = 1) as resync_count,
    avg(spread_bps) as avg_spread_bps,
    avg(mid_price) as avg_mid_price,
    avg(total_bid_depth) as avg_bid_depth,
    avg(total_ask_depth) as avg_ask_depth,
    avg(book_imbalance) as avg_imbalance
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
