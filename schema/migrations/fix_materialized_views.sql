-- ============================================================
-- FIX MATERIALIZED VIEWS - Recreate for new schema
-- ============================================================
-- Data Flow:
--   raw_polymarket.order_filled → trades_mv → trades
--                                               ↓
--                                 makers_mv → makers
--                                 takers_mv → takers
--                                 markets_mv → markets
-- ============================================================

-- ============================================================
-- STEP 1: Drop existing MVs
-- ============================================================
DROP VIEW IF EXISTS trading_data.trades_mv;
DROP VIEW IF EXISTS trading_data.makers_mv;
DROP VIEW IF EXISTS trading_data.takers_mv;
DROP VIEW IF EXISTS trading_data.markets_mv;

-- ============================================================
-- STEP 2: Recreate trades_mv
-- ============================================================
-- Sources from raw_polymarket.order_filled → trading_data.trades

CREATE MATERIALIZED VIEW trading_data.trades_mv
TO trading_data.trades
AS
SELECT
    'polymarket' AS market_source,
    'prediction' AS market_type,
    id,
    transaction_hash,
    order_hash,
    toDateTime64(toUInt64(timestamp), 0, 'UTC') AS timestamp,
    maker,
    taker,
    maker_asset_id,
    taker_asset_id,
    maker_asset_id AS token_id,
    toFloat32(toFloat64(maker_amount_filled) / 1000000) AS size,
    toFloat32(toFloat64(taker_amount_filled) / 1000000) AS usdc_volume,
    toFloat32(
        if(toFloat64(maker_amount_filled) > 0,
           toFloat64(taker_amount_filled) / toFloat64(maker_amount_filled),
           0)
    ) AS price,
    toFloat32(toFloat64(fee) / 1000000) AS fee_usdc,
    if(maker_asset_id < taker_asset_id, 'BUY', 'SELL') AS side
FROM raw_polymarket.order_filled
WHERE is_deleted = 0;

-- ============================================================
-- STEP 3: Recreate makers_mv
-- ============================================================
-- Aggregates maker activity from trades → makers table

CREATE MATERIALIZED VIEW trading_data.makers_mv
TO trading_data.makers
AS
SELECT
    market_source,
    market_type,
    maker AS user,
    token_id,
    toStartOfMinute(timestamp) AS timestamp,
    toUInt8(1) AS trades_count,
    toUInt64(usdc_volume * 1000000) AS usdc_volume_raw,
    toFloat64(usdc_volume) AS usdc_volume
FROM trading_data.trades;

-- ============================================================
-- STEP 4: Recreate takers_mv
-- ============================================================
-- Aggregates taker activity from trades → takers table

CREATE MATERIALIZED VIEW trading_data.takers_mv
TO trading_data.takers
AS
SELECT
    market_source,
    market_type,
    taker AS user,
    token_id,
    toStartOfMinute(timestamp) AS timestamp,
    toUInt8(1) AS trades_count,
    toUInt64(usdc_volume * 1000000) AS usdc_volume_raw,
    toFloat64(usdc_volume) AS usdc_volume
FROM trading_data.trades;

-- ============================================================
-- STEP 5: Recreate markets_mv
-- ============================================================
-- Aggregates market-level stats from trades → markets table

CREATE MATERIALIZED VIEW trading_data.markets_mv
TO trading_data.markets
AS
SELECT
    market_source,
    market_type,
    token_id,
    toStartOfMinute(timestamp) AS timestamp,
    toUInt64(1) AS trades_count,
    toUInt64(side = 'BUY') AS buys_count,
    toUInt64(side = 'SELL') AS sells_count,
    toUInt64(usdc_volume * 1000000) AS usdc_volume_raw,
    toFloat64(usdc_volume) AS usdc_volume,
    toUInt64(size * 1000000) AS shares_volume_raw,
    toUInt64(fee_usdc * 1000000) AS fees_raw
FROM trading_data.trades;

-- ============================================================
-- STEP 6: Verify MVs were created
-- ============================================================
SELECT name, engine
FROM system.tables
WHERE database = 'trading_data'
  AND name IN ('trades_mv', 'makers_mv', 'takers_mv', 'markets_mv');
