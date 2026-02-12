-- Migration: Graph Tables for Multi-Market Correlation System
-- Purpose: Store edge signals and aggregated graph data for market relationships
-- Run against ClickHouse trading_data database

-- ============================================================
-- 1. Edge Signal Log (append-only events)
-- Records every signal that contributes to graph edges
-- Sources: user analyses, triggers, cron correlation jobs, metadata tags
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.graph_edge_signals (
    market_a String,
    market_b String,
    edge_type LowCardinality(String),  -- correlation | hedge | causal | arbitrage
    signal_source LowCardinality(String), -- user_analysis | user_trigger | trigger_fire | trigger_miss | cron_correlation | metadata_tag | bellman_ford_cycle
    user_id String DEFAULT '',
    strength Float32 DEFAULT 1.0,
    metadata String DEFAULT '',
    created_at DateTime64(6) DEFAULT now64(6),
    created_date Date DEFAULT toDate(created_at)
) ENGINE = MergeTree()
PARTITION BY created_date
ORDER BY (edge_type, market_a, market_b, created_at)
TTL created_at + INTERVAL 90 DAY;

-- ============================================================
-- 2. Aggregated Edge Weights (periodic snapshot)
-- Rebuilt every 15 minutes from signals with decay
-- Used by GraphManager DO for fast graph queries
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.graph_edges (
    market_a String,
    market_b String,
    edge_type LowCardinality(String),
    weight Float32,  -- log(1 + signal_count) * recency_decay * avg_strength
    user_count UInt32,
    signal_count UInt32,
    last_signal_at DateTime64(6),
    updated_at DateTime64(6) DEFAULT now64(6)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (market_a, market_b, edge_type);

-- ============================================================
-- 3. Reverse Index for Bidirectional Queries
-- Allows efficient lookup of "what markets point TO this market"
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.graph_edges_reverse (
    market_b String,
    market_a String,
    edge_type LowCardinality(String),
    weight Float32,
    updated_at DateTime64(6) DEFAULT now64(6)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (market_b, market_a, edge_type);

-- ============================================================
-- 4. Materialized View: Auto-populate reverse index
-- Keeps reverse index in sync with main edges table
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS trading_data.graph_edges_reverse_mv
TO trading_data.graph_edges_reverse
AS SELECT
    market_b,
    market_a,
    edge_type,
    weight,
    updated_at
FROM trading_data.graph_edges;

-- ============================================================
-- 5. Graph Rebuild Query (run as cron every 15 min)
-- Aggregates signals with recency decay and source weighting
--
-- Weight formula:
-- - Logarithmic scaling of signal count
-- - Source-type weighting (trigger_fire > user_trigger > user_analysis)
-- - Exponential decay (30-day half-life)
-- ============================================================

-- This is the INSERT query to run during graph rebuild:
--
-- INSERT INTO trading_data.graph_edges
-- SELECT
--     market_a,
--     market_b,
--     edge_type,
--     -- Logarithmic scaling + exponential decay
--     log(1 + sum(
--       strength *
--       CASE signal_source
--         WHEN 'trigger_fire' THEN 2.0
--         WHEN 'user_trigger' THEN 1.5
--         WHEN 'user_analysis' THEN 1.0
--         WHEN 'trigger_miss' THEN 0.5  -- Negative strength already applied
--         WHEN 'cron_correlation' THEN 1.0
--         WHEN 'metadata_tag' THEN 0.8
--         WHEN 'bellman_ford_cycle' THEN 2.5
--         ELSE 1.0
--       END *
--       exp(-dateDiff('day', created_at, now()) / 30)  -- 30-day half-life
--     )) AS weight,
--     uniqExact(user_id) AS user_count,
--     count() AS signal_count,
--     max(created_at) AS last_signal_at,
--     now64(6) AS updated_at
-- FROM trading_data.graph_edge_signals
-- WHERE created_at > now() - INTERVAL 90 DAY
-- GROUP BY market_a, market_b, edge_type
-- HAVING weight > 0.1;  -- Prune weak/decayed edges

-- ============================================================
-- 6. Correlation Seeding Query (run as daily cron)
-- Inserts edges for markets with |correlation| > 0.6
-- ============================================================

-- Daily correlation seeding (positive correlations):
--
-- INSERT INTO trading_data.graph_edge_signals
-- SELECT
--     a.condition_id AS market_a,
--     b.condition_id AS market_b,
--     'correlation' AS edge_type,
--     'cron_correlation' AS signal_source,
--     '' AS user_id,
--     abs(corr(a.mid_price, b.mid_price)) AS strength,
--     '' AS metadata,
--     now64(6) AS created_at,
--     today() AS created_date
-- FROM trading_data.ob_bbo a
-- JOIN trading_data.ob_bbo b ON a.ingestion_ts = b.ingestion_ts
-- WHERE a.condition_id < b.condition_id
--   AND a.ingestion_ts > now() - INTERVAL 7 DAY
-- GROUP BY a.condition_id, b.condition_id
-- HAVING abs(corr(a.mid_price, b.mid_price)) > 0.6;

-- ============================================================
-- 7. Hedge Seeding Query (run as daily cron)
-- Inserts HEDGE edges for inverse correlations (< -0.5)
-- These have negative weights for Bellman-Ford cycle detection
-- ============================================================

-- Daily hedge seeding (negative correlations):
--
-- INSERT INTO trading_data.graph_edge_signals
-- SELECT
--     a.condition_id AS market_a,
--     b.condition_id AS market_b,
--     'hedge' AS edge_type,
--     'cron_correlation' AS signal_source,
--     '' AS user_id,
--     abs(corr(a.mid_price, b.mid_price)) AS strength,  -- Store absolute value
--     '' AS metadata,
--     now64(6) AS created_at,
--     today() AS created_date
-- FROM trading_data.ob_bbo a
-- JOIN trading_data.ob_bbo b ON a.ingestion_ts = b.ingestion_ts
-- WHERE a.condition_id < b.condition_id
--   AND a.ingestion_ts > now() - INTERVAL 7 DAY
-- GROUP BY a.condition_id, b.condition_id
-- HAVING corr(a.mid_price, b.mid_price) < -0.5;  -- Negative correlation = hedge

-- ============================================================
-- 8. Negative Cycle Alerts Table
-- Stores detected arbitrage opportunities from Bellman-Ford
-- ============================================================

CREATE TABLE IF NOT EXISTS trading_data.graph_negative_cycles (
    cycle_id String,
    markets Array(String),
    total_weight Float32,  -- Negative = arbitrage opportunity
    opportunity_type LowCardinality(String),  -- hedge_loop | inverse_correlation
    detected_at DateTime64(6) DEFAULT now64(6),
    detected_date Date DEFAULT toDate(detected_at),
    resolved_at DateTime64(6) DEFAULT toDateTime64('1970-01-01 00:00:00.000000', 6),
    metadata String DEFAULT ''
) ENGINE = MergeTree()
PARTITION BY detected_date
ORDER BY (detected_at, cycle_id)
TTL detected_at + INTERVAL 30 DAY;
