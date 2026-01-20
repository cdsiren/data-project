-- ============================================================
-- Migration 003: Recreate materialized views with market_source
-- ============================================================
-- This migration drops and recreates all materialized views
-- to include market_source in their ORDER BY and GROUP BY clauses.
--
-- Run this AFTER 002_add_market_source.sql
--
-- IMPORTANT: Dropping MVs will lose historical aggregated data.
-- The MVs will be rebuilt as new data flows in.
-- ============================================================

-- ============================================================
-- STEP 1: Drop existing materialized views
-- ============================================================

DROP VIEW IF EXISTS trading_data.v_ob_bbo_1m;
DROP VIEW IF EXISTS trading_data.v_ob_bbo_5m;
DROP MATERIALIZED VIEW IF EXISTS trading_data.mv_ob_bbo_1m;
DROP MATERIALIZED VIEW IF EXISTS trading_data.mv_ob_bbo_5m;
DROP MATERIALIZED VIEW IF EXISTS trading_data.mv_ob_hourly_stats;
DROP MATERIALIZED VIEW IF EXISTS trading_data.mv_ob_latency_hourly;


-- ============================================================
-- STEP 2: Recreate hourly orderbook statistics view
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_hourly_stats
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (market_source, asset_id, hour)
AS
SELECT
    market_source,
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
GROUP BY market_source, asset_id, hour;


-- ============================================================
-- STEP 3: Recreate latency percentiles view
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_latency_hourly
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMMDD(hour)
ORDER BY (market_source, hour)
TTL hour + INTERVAL 7 DAY
AS
SELECT
    market_source,
    toStartOfHour(source_ts) as hour,
    quantileState(0.50)(latency_ms) as p50_state,
    quantileState(0.95)(latency_ms) as p95_state,
    quantileState(0.99)(latency_ms) as p99_state,
    maxState(latency_ms) as max_state,
    countState() as count_state
FROM trading_data.ob_latency
GROUP BY market_source, hour;


-- ============================================================
-- STEP 4: Recreate 1-minute OHLC bars
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_bbo_1m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (market_source, asset_id, minute)
TTL minute + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192
AS SELECT
    market_source,
    asset_id,
    condition_id,
    toStartOfMinute(source_ts) AS minute,

    -- OHLC for best bid
    argMinState(best_bid, source_ts) AS open_bid_state,
    maxState(best_bid) AS high_bid_state,
    minState(best_bid) AS low_bid_state,
    argMaxState(best_bid, source_ts) AS close_bid_state,

    -- OHLC for best ask
    argMinState(best_ask, source_ts) AS open_ask_state,
    maxState(best_ask) AS high_ask_state,
    minState(best_ask) AS low_ask_state,
    argMaxState(best_ask, source_ts) AS close_ask_state,

    -- VWAP calculation
    sumState(mid_price * (bid_size + ask_size)) AS sum_price_volume_state,
    sumState(bid_size + ask_size) AS sum_volume_state,

    -- Spread metrics
    avgState(spread_bps) AS avg_spread_bps_state,
    minState(spread_bps) AS min_spread_bps_state,
    maxState(spread_bps) AS max_spread_bps_state,

    -- Depth metrics
    avgState(bid_size) AS avg_bid_size_state,
    avgState(ask_size) AS avg_ask_size_state,
    sumState(bid_size) AS total_bid_size_state,
    sumState(ask_size) AS total_ask_size_state,

    -- Imbalance
    avgState(
        if(bid_size + ask_size > 0,
           (bid_size - ask_size) / (bid_size + ask_size),
           0)
    ) AS avg_imbalance_state,

    -- Tick count and timing
    countState() AS tick_count_state,
    minState(source_ts) AS first_ts_state,
    maxState(source_ts) AS last_ts_state,

    -- Hash chain
    argMinState(book_hash, source_ts) AS first_hash_state,
    argMaxState(book_hash, source_ts) AS last_hash_state,

    -- Sequence tracking
    minState(sequence_number) AS sequence_start_state,
    maxState(sequence_number) AS sequence_end_state

FROM trading_data.ob_bbo
WHERE best_bid > 0 AND best_ask > 0
GROUP BY market_source, asset_id, condition_id, minute;


-- ============================================================
-- STEP 5: Recreate 5-minute OHLC bars
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.mv_ob_bbo_5m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_5m)
ORDER BY (market_source, asset_id, interval_5m)
TTL interval_5m + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192
AS SELECT
    market_source,
    asset_id,
    condition_id,
    toStartOfFiveMinutes(source_ts) AS interval_5m,

    -- OHLC for best bid
    argMinState(best_bid, source_ts) AS open_bid_state,
    maxState(best_bid) AS high_bid_state,
    minState(best_bid) AS low_bid_state,
    argMaxState(best_bid, source_ts) AS close_bid_state,

    -- OHLC for best ask
    argMinState(best_ask, source_ts) AS open_ask_state,
    maxState(best_ask) AS high_ask_state,
    minState(best_ask) AS low_ask_state,
    argMaxState(best_ask, source_ts) AS close_ask_state,

    -- VWAP
    sumState(mid_price * (bid_size + ask_size)) AS sum_price_volume_state,
    sumState(bid_size + ask_size) AS sum_volume_state,

    -- Spread metrics
    avgState(spread_bps) AS avg_spread_bps_state,
    minState(spread_bps) AS min_spread_bps_state,
    maxState(spread_bps) AS max_spread_bps_state,

    -- Depth metrics
    avgState(bid_size) AS avg_bid_size_state,
    avgState(ask_size) AS avg_ask_size_state,

    -- Imbalance
    avgState(
        if(bid_size + ask_size > 0,
           (bid_size - ask_size) / (bid_size + ask_size),
           0)
    ) AS avg_imbalance_state,

    -- Tick count and timing
    countState() AS tick_count_state,
    minState(source_ts) AS first_ts_state,
    maxState(source_ts) AS last_ts_state,

    -- Hash chain
    argMinState(book_hash, source_ts) AS first_hash_state,
    argMaxState(book_hash, source_ts) AS last_hash_state

FROM trading_data.ob_bbo
WHERE best_bid > 0 AND best_ask > 0
GROUP BY market_source, asset_id, condition_id, interval_5m;


-- ============================================================
-- STEP 6: Recreate helper views with market_source
-- ============================================================

CREATE VIEW IF NOT EXISTS trading_data.v_ob_bbo_1m AS
SELECT
    market_source,
    asset_id,
    condition_id,
    minute,

    -- OHLC Bid
    argMinMerge(open_bid_state) AS open_bid,
    maxMerge(high_bid_state) AS high_bid,
    minMerge(low_bid_state) AS low_bid,
    argMaxMerge(close_bid_state) AS close_bid,

    -- OHLC Ask
    argMinMerge(open_ask_state) AS open_ask,
    maxMerge(high_ask_state) AS high_ask,
    minMerge(low_ask_state) AS low_ask,
    argMaxMerge(close_ask_state) AS close_ask,

    -- Mid price OHLC (derived)
    (argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2 AS open_mid,
    (maxMerge(high_bid_state) + minMerge(low_ask_state)) / 2 AS high_mid,
    (minMerge(low_bid_state) + maxMerge(high_ask_state)) / 2 AS low_mid,
    (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2 AS close_mid,

    -- VWAP
    if(sumMerge(sum_volume_state) > 0,
       sumMerge(sum_price_volume_state) / sumMerge(sum_volume_state),
       (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2
    ) AS vwap_mid,

    -- Spread
    avgMerge(avg_spread_bps_state) AS avg_spread_bps,
    minMerge(min_spread_bps_state) AS min_spread_bps,
    maxMerge(max_spread_bps_state) AS max_spread_bps,

    -- Depth
    avgMerge(avg_bid_size_state) AS avg_bid_size,
    avgMerge(avg_ask_size_state) AS avg_ask_size,
    sumMerge(total_bid_size_state) AS total_bid_volume,
    sumMerge(total_ask_size_state) AS total_ask_volume,

    -- Imbalance
    avgMerge(avg_imbalance_state) AS avg_imbalance,

    -- Metadata
    countMerge(tick_count_state) AS tick_count,
    minMerge(first_ts_state) AS first_ts,
    maxMerge(last_ts_state) AS last_ts,
    argMinMerge(first_hash_state) AS first_hash,
    argMaxMerge(last_hash_state) AS last_hash,
    minMerge(sequence_start_state) AS sequence_start,
    maxMerge(sequence_end_state) AS sequence_end

FROM trading_data.mv_ob_bbo_1m
GROUP BY market_source, asset_id, condition_id, minute;


CREATE VIEW IF NOT EXISTS trading_data.v_ob_bbo_5m AS
SELECT
    market_source,
    asset_id,
    condition_id,
    interval_5m,

    -- OHLC Bid
    argMinMerge(open_bid_state) AS open_bid,
    maxMerge(high_bid_state) AS high_bid,
    minMerge(low_bid_state) AS low_bid,
    argMaxMerge(close_bid_state) AS close_bid,

    -- OHLC Ask
    argMinMerge(open_ask_state) AS open_ask,
    maxMerge(high_ask_state) AS high_ask,
    minMerge(low_ask_state) AS low_ask,
    argMaxMerge(close_ask_state) AS close_ask,

    -- Mid price OHLC
    (argMinMerge(open_bid_state) + argMinMerge(open_ask_state)) / 2 AS open_mid,
    (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2 AS close_mid,

    -- VWAP
    if(sumMerge(sum_volume_state) > 0,
       sumMerge(sum_price_volume_state) / sumMerge(sum_volume_state),
       (argMaxMerge(close_bid_state) + argMaxMerge(close_ask_state)) / 2
    ) AS vwap_mid,

    -- Spread
    avgMerge(avg_spread_bps_state) AS avg_spread_bps,
    minMerge(min_spread_bps_state) AS min_spread_bps,
    maxMerge(max_spread_bps_state) AS max_spread_bps,

    -- Depth
    avgMerge(avg_bid_size_state) AS avg_bid_size,
    avgMerge(avg_ask_size_state) AS avg_ask_size,

    -- Imbalance
    avgMerge(avg_imbalance_state) AS avg_imbalance,

    -- Metadata
    countMerge(tick_count_state) AS tick_count,
    minMerge(first_ts_state) AS first_ts,
    maxMerge(last_ts_state) AS last_ts

FROM trading_data.mv_ob_bbo_5m
GROUP BY market_source, asset_id, condition_id, interval_5m;


-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

-- Verify materialized views exist
-- SELECT name, engine FROM system.tables
-- WHERE database = 'trading_data' AND engine LIKE '%Materialized%';

-- Check view columns include market_source
-- SELECT table, name FROM system.columns
-- WHERE database = 'trading_data' AND name = 'market_source'
-- ORDER BY table;
