-- ============================================================
-- MATERIALIZED VIEWS FOR BBO AGGREGATION
-- Replaces DO-based SnapshotAggregator with ClickHouse-native aggregation
-- More efficient: columnar processing, automatic incremental updates
-- ============================================================

-- ============================================================
-- 1-MINUTE OHLC BARS
-- Primary table for strategy backtesting and signal generation
-- Uses AggregatingMergeTree for correct merge behavior
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS polymarket.mv_ob_bbo_1m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (asset_id, minute)
TTL minute + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192
AS SELECT
    asset_id,
    condition_id,
    toStartOfMinute(source_ts) AS minute,

    -- OHLC for best bid (use argMin/argMax for open/close by timestamp)
    argMinState(best_bid, source_ts) AS open_bid_state,
    maxState(best_bid) AS high_bid_state,
    minState(best_bid) AS low_bid_state,
    argMaxState(best_bid, source_ts) AS close_bid_state,

    -- OHLC for best ask
    argMinState(best_ask, source_ts) AS open_ask_state,
    maxState(best_ask) AS high_ask_state,
    minState(best_ask) AS low_ask_state,
    argMaxState(best_ask, source_ts) AS close_ask_state,

    -- VWAP calculation (volume-weighted by top-of-book size)
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

    -- Imbalance: (bid_size - ask_size) / (bid_size + ask_size)
    avgState(
        if(bid_size + ask_size > 0,
           (bid_size - ask_size) / (bid_size + ask_size),
           0)
    ) AS avg_imbalance_state,

    -- Tick count and timing
    countState() AS tick_count_state,
    minState(source_ts) AS first_ts_state,
    maxState(source_ts) AS last_ts_state,

    -- Hash chain for gap detection
    argMinState(book_hash, source_ts) AS first_hash_state,
    argMaxState(book_hash, source_ts) AS last_hash_state,

    -- Sequence tracking
    minState(sequence_number) AS sequence_start_state,
    maxState(sequence_number) AS sequence_end_state

FROM polymarket.ob_bbo
WHERE best_bid > 0 AND best_ask > 0  -- Filter out invalid quotes
GROUP BY asset_id, condition_id, minute;


-- ============================================================
-- 5-MINUTE OHLC BARS
-- For longer-term strategy analysis and reduced query load
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS polymarket.mv_ob_bbo_5m
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_5m)
ORDER BY (asset_id, interval_5m)
TTL interval_5m + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192
AS SELECT
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

FROM polymarket.ob_bbo
WHERE best_bid > 0 AND best_ask > 0
GROUP BY asset_id, condition_id, interval_5m;


-- ============================================================
-- HELPER VIEW: Query 1-minute bars with proper Merge functions
-- Use this view for easy querying without manual Merge() calls
-- ============================================================

CREATE VIEW IF NOT EXISTS polymarket.v_ob_bbo_1m AS
SELECT
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

FROM polymarket.mv_ob_bbo_1m
GROUP BY asset_id, condition_id, minute;


-- ============================================================
-- HELPER VIEW: Query 5-minute bars with proper Merge functions
-- ============================================================

CREATE VIEW IF NOT EXISTS polymarket.v_ob_bbo_5m AS
SELECT
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

FROM polymarket.mv_ob_bbo_5m
GROUP BY asset_id, condition_id, interval_5m;


-- ============================================================
-- EXAMPLE QUERIES
-- ============================================================

-- Get 1-minute candles for an asset (last 24 hours)
-- SELECT * FROM polymarket.v_ob_bbo_1m
-- WHERE asset_id = 'your_asset_id'
--   AND minute >= now() - INTERVAL 24 HOUR
-- ORDER BY minute;

-- Get 5-minute candles with price change calculation
-- SELECT
--     *,
--     (close_mid - open_mid) / open_mid * 100 AS pct_change,
--     close_mid - lagInFrame(close_mid) OVER (PARTITION BY asset_id ORDER BY interval_5m) AS price_delta
-- FROM polymarket.v_ob_bbo_5m
-- WHERE asset_id = 'your_asset_id'
--   AND interval_5m >= now() - INTERVAL 7 DAY
-- ORDER BY interval_5m;

-- Identify high-spread periods (liquidity gaps)
-- SELECT asset_id, minute, avg_spread_bps, tick_count
-- FROM polymarket.v_ob_bbo_1m
-- WHERE avg_spread_bps > 100  -- Spread > 1%
--   AND minute >= now() - INTERVAL 1 DAY
-- ORDER BY avg_spread_bps DESC
-- LIMIT 100;
