-- ============================================================
-- Polymarket Optimized Schema
-- Target: 10x cost reduction via buffer tables, TTL, and aggregation
-- Run in existing polymarket database
-- ============================================================

-- ============================================================
-- BUFFER + MERGE TREE PATTERN
-- Buffer tables accumulate writes in memory then flush to MergeTree
-- This converts thousands of single-row INSERTs into bulk INSERTs
-- ============================================================

-- Order Filled - Main MergeTree table
CREATE TABLE IF NOT EXISTS polymarket.order_filled (
    id String,
    transaction_hash LowCardinality(String),
    timestamp DateTime64(3),
    order_hash LowCardinality(String),
    maker LowCardinality(String),
    taker LowCardinality(String),
    maker_asset_id String,
    taker_asset_id String,
    maker_amount_filled UInt64,
    taker_amount_filled UInt64,
    fee UInt64,
    chain_id UInt16 DEFAULT 137,
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, id)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400,
    min_bytes_for_wide_part = 10485760,
    min_rows_for_wide_part = 100000,
    parts_to_delay_insert = 300,
    parts_to_throw_insert = 600,
    max_parts_in_total = 10000;

-- Buffer table for order_filled
CREATE TABLE IF NOT EXISTS polymarket.order_filled_buffer AS polymarket.order_filled
ENGINE = Buffer(
    polymarket, order_filled, 16,
    10, 100,           -- time: min 10s, max 100s
    10000, 100000,     -- rows: min 10K, max 100K
    10000000, 100000000 -- bytes: min 10MB, max 100MB
);

-- Orders Matched
CREATE TABLE IF NOT EXISTS polymarket.orders_matched (
    id String,
    timestamp DateTime64(6),  -- Microsecond precision for HFT
    maker_asset_id String,
    taker_asset_id String,
    maker_address LowCardinality(String),
    taker_address LowCardinality(String),
    price Decimal128(18),  -- Exact decimal precision (no float errors)
    size UInt64,
    side LowCardinality(String),
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, id)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 86400;

CREATE TABLE IF NOT EXISTS polymarket.orders_matched_buffer AS polymarket.orders_matched
ENGINE = Buffer(polymarket, orders_matched, 16, 10, 100, 10000, 100000, 10000000, 100000000);

-- Global Open Interest
CREATE TABLE IF NOT EXISTS polymarket.global_open_interest (
    id String,
    timestamp DateTime64(3),
    open_interest Float64,
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, id)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 86400;

CREATE TABLE IF NOT EXISTS polymarket.global_open_interest_buffer AS polymarket.global_open_interest
ENGINE = Buffer(polymarket, global_open_interest, 8, 10, 100, 5000, 50000, 5000000, 50000000);

-- Market Open Interest
CREATE TABLE IF NOT EXISTS polymarket.market_open_interest (
    id String,
    timestamp DateTime64(3),
    condition_id String,
    open_interest Float64,
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (condition_id, timestamp, id)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 86400;

CREATE TABLE IF NOT EXISTS polymarket.market_open_interest_buffer AS polymarket.market_open_interest
ENGINE = Buffer(polymarket, market_open_interest, 8, 10, 100, 5000, 50000, 5000000, 50000000);

-- User Balances
CREATE TABLE IF NOT EXISTS polymarket.user_balances (
    id String,
    timestamp DateTime64(3),
    user_address LowCardinality(String),
    asset_id String,
    balance UInt64,
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_address, asset_id, timestamp)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 86400;

CREATE TABLE IF NOT EXISTS polymarket.user_balances_buffer AS polymarket.user_balances
ENGINE = Buffer(polymarket, user_balances, 16, 10, 100, 10000, 100000, 10000000, 100000000);

-- User Positions
CREATE TABLE IF NOT EXISTS polymarket.user_positions (
    id String,
    timestamp DateTime64(3),
    user_address LowCardinality(String),
    condition_id String,
    outcome_index UInt8,
    position UInt64,
    _gs_chain LowCardinality(String),
    _gs_gid String,
    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_address, condition_id, timestamp)
TTL timestamp + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 86400;

CREATE TABLE IF NOT EXISTS polymarket.user_positions_buffer AS polymarket.user_positions
ENGINE = Buffer(polymarket, user_positions, 16, 10, 100, 10000, 100000, 10000000, 100000000);

-- ============================================================
-- AGGREGATED ORDERBOOK SNAPSHOTS (1-minute OHLC)
-- Replaces tick-by-tick snapshots - 60x data reduction
-- HFT-grade precision: Decimal128 for prices, microsecond timestamps
-- ============================================================

CREATE TABLE IF NOT EXISTS polymarket.ob_snapshots_1m (
    asset_id String,
    condition_id String,
    minute DateTime,

    -- OHLC for best bid (Decimal128 for exact precision - no float errors)
    open_bid Decimal128(18),
    high_bid Decimal128(18),
    low_bid Decimal128(18),
    close_bid Decimal128(18),

    -- OHLC for best ask (Decimal128 for exact precision)
    open_ask Decimal128(18),
    high_ask Decimal128(18),
    low_ask Decimal128(18),
    close_ask Decimal128(18),

    -- True VWAP (volume-weighted average price)
    vwap_mid Decimal128(18),

    -- Depth metrics (averaged over minute)
    avg_spread_bps Float64,
    avg_bid_depth UInt64,  -- Changed to UInt64 for raw token units
    avg_ask_depth UInt64,  -- Changed to UInt64 for raw token units
    avg_bid_depth_5 UInt64,  -- NEW: Top 5 bid levels depth
    avg_ask_depth_5 UInt64,  -- NEW: Top 5 ask levels depth
    avg_imbalance Float64,

    -- Volume tracking for true VWAP calculation
    total_bid_volume UInt64,  -- NEW: Sum of all bid volume in bar
    total_ask_volume UInt64,  -- NEW: Sum of all ask volume in bar

    tick_count UInt32,

    -- Timing with microsecond precision
    first_source_ts DateTime64(6),  -- NEW: First tick timestamp (us)
    last_source_ts DateTime64(6),   -- NEW: Last tick timestamp (us)

    -- Hash chain for gap detection
    first_hash String,
    last_hash String,
    sequence_start UInt64,  -- NEW: First sequence number in bar
    sequence_end UInt64,    -- NEW: Last sequence number in bar

    inserted_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(minute)
ORDER BY (asset_id, minute)
TTL minute + INTERVAL 180 DAY DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400,
    min_bytes_for_wide_part = 10485760,
    parts_to_delay_insert = 150,
    parts_to_throw_insert = 300;

CREATE TABLE IF NOT EXISTS polymarket.ob_snapshots_1m_buffer AS polymarket.ob_snapshots_1m
ENGINE = Buffer(polymarket, ob_snapshots_1m, 16, 60, 120, 1000, 10000, 1000000, 10000000);

-- Real-time tick buffer (24h TTL for triggers/alerts only)
-- HFT-grade: Decimal128 prices, microsecond timestamps, tick direction
CREATE TABLE IF NOT EXISTS polymarket.ob_ticks_realtime (
    asset_id String,
    source_ts DateTime64(6),  -- Microsecond precision
    best_bid Decimal128(18),  -- Exact decimal precision
    best_ask Decimal128(18),  -- Exact decimal precision
    mid_price Decimal128(18), -- Pre-computed mid
    spread_bps Float64,       -- Spread in basis points
    tick_direction Enum8('UP' = 1, 'DOWN' = -1, 'UNCHANGED' = 0),  -- NEW: Price movement
    crossed UInt8,            -- NEW: 1 if bid >= ask (error condition)
    book_hash String,
    sequence_number UInt64,   -- NEW: For ordering
    ingestion_ts DateTime64(6)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(source_ts)
ORDER BY (asset_id, source_ts, sequence_number)
TTL source_ts + INTERVAL 1 DAY DELETE
SETTINGS index_granularity = 8192, merge_with_ttl_timeout = 3600;

-- ============================================================
-- MONITORING VIEWS
-- ============================================================

-- View to check current buffer status
CREATE VIEW IF NOT EXISTS polymarket.v_buffer_status AS
SELECT
    database,
    table,
    rows,
    bytes,
    flush_count
FROM system.buffer
WHERE database = 'polymarket';

-- View to check merge pressure
CREATE VIEW IF NOT EXISTS polymarket.v_merge_pressure AS
SELECT
    database,
    table,
    count() as parts_count,
    sum(rows) as total_rows,
    sum(bytes_on_disk) as total_bytes
FROM system.parts
WHERE database = 'polymarket'
  AND active = 1
GROUP BY database, table
ORDER BY parts_count DESC;

-- View to check TTL deletions pending
CREATE VIEW IF NOT EXISTS polymarket.v_ttl_pending AS
SELECT
    database,
    table,
    partition,
    delete_ttl_info_min,
    delete_ttl_info_max,
    rows
FROM system.parts
WHERE database = 'polymarket'
  AND active = 1
  AND delete_ttl_info_min IS NOT NULL
ORDER BY delete_ttl_info_min;
