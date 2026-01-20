-- ============================================================
-- Migration 002: Add market_source and market_type columns
-- ============================================================
-- This migration adds market discriminator columns to enable
-- multi-market storage in a single database.
--
-- Following Nautilus Trader (Venue + AssetClass) and CCXT (type) patterns:
-- - market_source: The exchange/platform (polymarket, kalshi, uniswap)
-- - market_type: The market category (prediction, dex, cex)
--
-- Run this AFTER 001_rename_database.sql
--
-- IMPORTANT: The ORDER BY modifications require table recreation
-- in ClickHouse. For large tables, this can take significant time.
-- ============================================================

-- ============================================================
-- STEP 1: Add market_source and market_type columns to base tables
-- Default to 'polymarket' and 'prediction' for existing data
-- ============================================================

-- ob_snapshots
ALTER TABLE trading_data.ob_snapshots
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.ob_snapshots
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- ob_bbo
ALTER TABLE trading_data.ob_bbo
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.ob_bbo
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- ob_level_changes
ALTER TABLE trading_data.ob_level_changes
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.ob_level_changes
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- trade_ticks (if exists)
ALTER TABLE trading_data.trade_ticks
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.trade_ticks
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- ob_gap_events
ALTER TABLE trading_data.ob_gap_events
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.ob_gap_events
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- ob_latency
ALTER TABLE trading_data.ob_latency
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.ob_latency
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- dead_letter_messages
ALTER TABLE trading_data.dead_letter_messages
    ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;
ALTER TABLE trading_data.dead_letter_messages
    ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;


-- ============================================================
-- STEP 2: Update ORDER BY to include market_source and market_type
--
-- IMPORTANT: ClickHouse requires PRIMARY KEY to be a prefix of ORDER BY.
-- Since tables were created with ORDER BY (asset_id, ...), we must keep
-- asset_id first. We append market columns for filtering capability.
--
-- For optimal cross-market queries, use PARTITION BY market_type instead
-- (see Step 3), or create secondary data skipping indexes.
--
-- NOTE: ClickHouse will recreate the table with new ordering.
-- This is an offline operation for large tables.
-- ============================================================

-- ob_snapshots: ORDER BY (asset_id, market_type, market_source, source_ts, ingestion_ts)
ALTER TABLE trading_data.ob_snapshots
    MODIFY ORDER BY (asset_id, market_type, market_source, source_ts, ingestion_ts);

-- ob_bbo: ORDER BY (asset_id, market_type, market_source, source_ts, ingestion_ts)
ALTER TABLE trading_data.ob_bbo
    MODIFY ORDER BY (asset_id, market_type, market_source, source_ts, ingestion_ts);

-- ob_level_changes: ORDER BY (asset_id, market_type, market_source, source_ts, sequence_number)
ALTER TABLE trading_data.ob_level_changes
    MODIFY ORDER BY (asset_id, market_type, market_source, source_ts, sequence_number);

-- trade_ticks: ORDER BY (asset_id, market_type, market_source, source_ts)
ALTER TABLE trading_data.trade_ticks
    MODIFY ORDER BY (asset_id, market_type, market_source, source_ts);

-- ob_gap_events: ORDER BY (asset_id, market_type, market_source, detected_at)
ALTER TABLE trading_data.ob_gap_events
    MODIFY ORDER BY (asset_id, market_type, market_source, detected_at);

-- ob_latency: ORDER BY (source_ts, market_type, market_source, asset_id)
ALTER TABLE trading_data.ob_latency
    MODIFY ORDER BY (source_ts, market_type, market_source, asset_id);

-- dead_letter_messages: ORDER BY (original_queue, market_type, market_source, message_type, failed_at)
ALTER TABLE trading_data.dead_letter_messages
    MODIFY ORDER BY (original_queue, market_type, market_source, message_type, failed_at);


-- ============================================================
-- STEP 3: Add data skipping indexes for market_type/market_source
-- Since these aren't leading ORDER BY columns, indexes help filtering
-- ============================================================

-- ob_bbo indexes
ALTER TABLE trading_data.ob_bbo
    ADD INDEX IF NOT EXISTS idx_market_type market_type TYPE set(10) GRANULARITY 4;
ALTER TABLE trading_data.ob_bbo
    ADD INDEX IF NOT EXISTS idx_market_source market_source TYPE set(10) GRANULARITY 4;

-- ob_snapshots indexes
ALTER TABLE trading_data.ob_snapshots
    ADD INDEX IF NOT EXISTS idx_market_type market_type TYPE set(10) GRANULARITY 4;
ALTER TABLE trading_data.ob_snapshots
    ADD INDEX IF NOT EXISTS idx_market_source market_source TYPE set(10) GRANULARITY 4;

-- trade_ticks indexes
ALTER TABLE trading_data.trade_ticks
    ADD INDEX IF NOT EXISTS idx_market_type market_type TYPE set(10) GRANULARITY 4;
ALTER TABLE trading_data.trade_ticks
    ADD INDEX IF NOT EXISTS idx_market_source market_source TYPE set(10) GRANULARITY 4;

-- ob_level_changes indexes
ALTER TABLE trading_data.ob_level_changes
    ADD INDEX IF NOT EXISTS idx_market_type market_type TYPE set(10) GRANULARITY 4;
ALTER TABLE trading_data.ob_level_changes
    ADD INDEX IF NOT EXISTS idx_market_source market_source TYPE set(10) GRANULARITY 4;


-- ============================================================
-- STEP 4: Update PARTITION BY to include market_type (OPTIONAL)
-- This allows for efficient data management and pruning per market type
-- ============================================================

-- Modify partitioning for main tables (optional but recommended for large scale)
-- Note: This requires table recreation. For large tables, you may
-- want to create a new table and migrate data instead.

-- Example for ob_bbo (uncomment if you want partition change):
-- ALTER TABLE trading_data.ob_bbo
--     MODIFY SETTING partition_by = '(market_type, toYYYYMM(source_ts))';


-- ============================================================
-- STEP 5: Backfill market_source for existing data
-- This ensures all existing rows have market_source = 'polymarket'
-- ============================================================

-- The DEFAULT clause should handle this automatically,
-- but we can verify with:
-- SELECT market_source, count() FROM trading_data.ob_bbo GROUP BY market_source;
-- SELECT market_source, count() FROM trading_data.ob_snapshots GROUP BY market_source;


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after migration to verify success
-- ============================================================

-- Check columns exist in all tables
-- SELECT table, name, type FROM system.columns
-- WHERE database = 'trading_data' AND name IN ('market_source', 'market_type');

-- Verify data integrity by market_source
-- SELECT market_source, market_type, count() as row_count FROM trading_data.ob_bbo GROUP BY market_source, market_type;
-- SELECT market_source, market_type, count() as row_count FROM trading_data.ob_snapshots GROUP BY market_source, market_type;
-- SELECT market_source, market_type, count() as row_count FROM trading_data.ob_level_changes GROUP BY market_source, market_type;

-- Example queries by market_type (cross-market analysis):
-- All prediction market spreads:
-- SELECT market_source, avg(spread_bps) FROM trading_data.ob_bbo WHERE market_type = 'prediction' GROUP BY market_source;
--
-- All DEX volume:
-- SELECT market_source, sum(size) FROM trading_data.trade_ticks WHERE market_type = 'dex' GROUP BY market_source;
