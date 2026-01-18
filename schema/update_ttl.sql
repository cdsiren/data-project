-- ============================================================
-- UPDATE TTL: Extend ob_bbo retention to 90 days for backtesting
-- Per trigger-architect recommendation: tick data is valuable
-- ============================================================

-- Extend ob_bbo TTL from default to 90 days
ALTER TABLE polymarket.ob_bbo MODIFY TTL source_ts + INTERVAL 90 DAY DELETE;

-- Verify TTL settings
SELECT
    database,
    name,
    engine,
    partition_key,
    sorting_key,
    primary_key,
    total_rows,
    formatReadableSize(total_bytes) as size
FROM system.tables
WHERE database = 'polymarket'
  AND name = 'ob_bbo';
