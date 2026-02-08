-- ============================================================
-- FIX MISSING COLUMNS - Add back market_source and market_type
-- ============================================================
-- The trades table migration was missing these columns.
-- This script adds them back with proper defaults.
-- ============================================================

-- STEP 1: Add missing columns to trades table
ALTER TABLE trading_data.trades
ADD COLUMN IF NOT EXISTS market_source LowCardinality(String) DEFAULT 'polymarket' FIRST;

ALTER TABLE trading_data.trades
ADD COLUMN IF NOT EXISTS market_type LowCardinality(String) DEFAULT 'prediction' AFTER market_source;

-- STEP 2: Verify columns were added
SELECT name, type, default_expression
FROM system.columns
WHERE database = 'trading_data' AND table = 'trades'
ORDER BY position
LIMIT 5;

-- STEP 3: Verify all tables have market_source/market_type
SELECT
    table,
    countIf(name = 'market_source') as has_market_source,
    countIf(name = 'market_type') as has_market_type
FROM system.columns
WHERE database = 'trading_data'
  AND table IN ('trades', 'trade_ticks', 'ob_bbo', 'ob_snapshots', 'ob_level_changes')
GROUP BY table
ORDER BY table;

-- STEP 4: Verify defaults applied
SELECT market_source, market_type, count() as cnt
FROM trading_data.trades
GROUP BY market_source, market_type;
