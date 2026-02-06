-- ============================================================
-- Cost Reduction Migration
-- This migration implements changes to reduce ClickHouse compute costs
-- Run manually against ClickHouse before deploying code changes
-- ============================================================

-- ============================================================
-- Phase 1: Drop OHLC Materialized Views (Largest savings: 40-50% merge CPU)
-- These MVs process every ob_bbo insert for candlestick aggregation
-- Raw data is preserved in ob_bbo for on-demand OHLC computation
-- ============================================================

DROP VIEW IF EXISTS trading_data.v_ob_bbo_1m;
DROP VIEW IF EXISTS trading_data.v_ob_bbo_5m;
DROP VIEW IF EXISTS trading_data.mv_ob_bbo_1m;
DROP VIEW IF EXISTS trading_data.mv_ob_bbo_5m;

-- ============================================================
-- Phase 3: TTL Optimization for ML/Backtesting
-- Strategy: 365 days for backtesting tables, shorter for operational
-- ============================================================

-- Backtesting tables: 365 day retention
ALTER TABLE trading_data.ob_bbo
MODIFY TTL source_ts + INTERVAL 365 DAY;

ALTER TABLE trading_data.ob_snapshots
MODIFY TTL source_ts + INTERVAL 365 DAY;

ALTER TABLE trading_data.trade_ticks
MODIFY TTL source_ts + INTERVAL 365 DAY;

ALTER TABLE trading_data.trades
MODIFY TTL timestamp + INTERVAL 365 DAY;

-- Operational tables: shorter retention
ALTER TABLE trading_data.ob_level_changes
MODIFY TTL source_ts + INTERVAL 14 DAY;

ALTER TABLE trading_data.ob_latency
MODIFY TTL source_ts + INTERVAL 7 DAY;

ALTER TABLE trading_data.ob_gap_events
MODIFY TTL detected_at + INTERVAL 30 DAY;

ALTER TABLE trading_data.dead_letter_messages
MODIFY TTL failed_at + INTERVAL 14 DAY;

-- ============================================================
-- Phase 4: Table-Level Merge Settings (1.5-2x fewer merges)
-- Optimizes merge behavior for high-volume tables
-- Note: parts_to_throw_insert is managed by ClickHouse Cloud
-- ============================================================

ALTER TABLE trading_data.ob_bbo MODIFY SETTING
    min_bytes_for_wide_part = 50000000;

ALTER TABLE trading_data.ob_level_changes MODIFY SETTING
    min_bytes_for_wide_part = 50000000;

ALTER TABLE trading_data.ob_snapshots MODIFY SETTING
    min_bytes_for_wide_part = 50000000;

ALTER TABLE trading_data.trade_ticks MODIFY SETTING
    min_bytes_for_wide_part = 50000000;

-- ============================================================
-- Verification Queries (run after migration to verify)
-- ============================================================

-- Verify MVs are dropped
-- SELECT name, engine FROM system.tables WHERE database = 'trading_data' AND name LIKE '%mv_ob_bbo%';

-- Verify TTL changes
-- SELECT name, engine, data_paths, TTL FROM system.tables WHERE database = 'trading_data';

-- Verify merge settings
-- SELECT name, value FROM system.merge_tree_settings WHERE database = 'trading_data' AND name IN ('min_bytes_for_wide_part', 'parts_to_throw_insert');

-- Monitor merge activity after changes
-- SELECT database, table, count() as merges,
--        round(sum(duration_ms)/1000/60, 1) as minutes
-- FROM system.part_log
-- WHERE event_time > now() - INTERVAL 24 HOUR
--   AND event_type = 'MergeParts'
-- GROUP BY database, table
-- ORDER BY minutes DESC;
