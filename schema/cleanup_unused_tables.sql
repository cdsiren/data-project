-- ============================================================
-- CLEANUP: Drop unused tables and views
-- Run this AFTER creating the new materialized views
-- ============================================================

-- Drop the old DO-based aggregation table (replaced by mv_ob_bbo_1m)
DROP TABLE IF EXISTS polymarket.ob_snapshots_1m;
DROP TABLE IF EXISTS polymarket.ob_snapshots_1m_buffer;

-- Drop the unused realtime ticks table (triggers fire via webhooks instead)
DROP TABLE IF EXISTS polymarket.ob_ticks_realtime;

-- Verify cleanup
SELECT
    database,
    name,
    engine,
    total_rows,
    formatReadableSize(total_bytes) as size
FROM system.tables
WHERE database = 'polymarket'
  AND name IN ('ob_snapshots_1m', 'ob_snapshots_1m_buffer', 'ob_ticks_realtime');
