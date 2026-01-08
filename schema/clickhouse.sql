-- Create database if it doesn't exist
CREATE DATABASE IF NOT EXISTS polymarket;

-- Market Metadata Table
-- Stores market information from Polymarket API
-- Uses ReplacingMergeTree to handle potential duplicate inserts
CREATE TABLE IF NOT EXISTS polymarket.market_metadata (
    id String,
    question String,
    condition_id String,
    slug String,
    resolution_source String,
    end_date DateTime,
    start_date DateTime,
    created_at DateTime,
    submitted_by String,
    resolved_by String,
    restricted UInt8,
    enable_order_book UInt8,
    order_price_min_tick_size Float64,
    order_min_size Float64,
    clob_token_ids String,
    neg_risk UInt8,
    neg_risk_market_id String,
    neg_risk_request_id String,
    inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (id)
PRIMARY KEY (id);

-- Market Events Table
-- Stores events associated with markets
-- Links to market_metadata via market_id
CREATE TABLE IF NOT EXISTS polymarket.market_events (
    event_id String,
    market_id String,
    title String,
    inserted_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (event_id, market_id)
PRIMARY KEY (event_id, market_id);

-- Index on market_id for efficient lookups
ALTER TABLE polymarket.market_events ADD INDEX IF NOT EXISTS idx_market_id market_id TYPE bloom_filter GRANULARITY 1;

-- Index on condition_id for market_metadata lookups
ALTER TABLE polymarket.market_metadata ADD INDEX IF NOT EXISTS idx_condition_id condition_id TYPE bloom_filter GRANULARITY 1;

-- Index on clob_token_ids for lookups by token
ALTER TABLE polymarket.market_metadata ADD INDEX IF NOT EXISTS idx_clob_token_ids clob_token_ids TYPE bloom_filter GRANULARITY 1;
