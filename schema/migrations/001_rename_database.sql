-- ============================================================
-- Migration 001: Rename database from polymarket to trading_data
-- ============================================================
-- This migration renames the database to support multiple markets.
-- Run this FIRST before running 002_add_market_source.sql
--
-- IMPORTANT: This is a blocking operation. Plan for brief downtime.
-- ============================================================

-- Step 1: Rename database
RENAME DATABASE polymarket TO trading_data;

-- Verify the rename worked
-- SELECT name FROM system.databases WHERE name = 'trading_data';
