// src/schemas/backtest.ts
// Backtest data export Zod schemas

import { z } from "zod";
import { AssetIdSchema, ConditionIdSchema } from "./common";

// ============================================================
// Backtest Granularity
// ============================================================

export const BacktestGranularitySchema = z.enum(["tick", "ohlc"]);

// ============================================================
// Backtest Export Query Parameters
// ============================================================

export const BacktestExportQuerySchema = z.object({
  asset_id: z.string(),
  start: z.string(),
  end: z.string(),
  granularity: z
    .string()
    .optional()
    .default("tick")
    .transform((v) => (v === "ohlc" ? "ohlc" : "tick")),
  limit: z
    .string()
    .optional()
    .default("100000")
    .transform((v) => Math.min(parseInt(v, 10) || 100000, 1000000)),
});

// ============================================================
// Tick-Level Data Schema
// ============================================================

export const BacktestTickSchema = z.object({
  source_ts: z.string(),
  best_bid: z.number(),
  best_ask: z.number(),
  bid_size: z.number(),
  ask_size: z.number(),
  mid_price: z.number(),
  spread_bps: z.number(),
  book_hash: z.string(),
  sequence_number: z.number(),
});

// ============================================================
// OHLC Bar Data Schema
// ============================================================

export const BacktestOHLCSchema = z.object({
  time: z.number(),
  open_bid: z.number(),
  close_bid: z.number(),
  open_ask: z.number(),
  close_ask: z.number(),
  open_mid: z.number(),
  close_mid: z.number(),
  avg_spread_bps: z.number(),
  tick_count: z.number(),
  sequence_start: z.number(),
  sequence_end: z.number(),
});

// ============================================================
// Backtest Export Response
// ============================================================

export const BacktestExportResponseSchema = z.object({
  data: z.array(z.union([BacktestTickSchema, BacktestOHLCSchema])),
  rows: z.number(),
  asset_id: AssetIdSchema,
  granularity: BacktestGranularitySchema,
  start: z.string(),
  end: z.string(),
});

// ============================================================
// Available Assets Response
// ============================================================

export const BacktestAssetSchema = z.object({
  asset_id: AssetIdSchema,
  condition_id: ConditionIdSchema,
  total_ticks: z.number(),
  first_tick: z.string(),
  last_tick: z.string(),
  days_of_data: z.number(),
});

export const BacktestAssetsQuerySchema = z.object({
  min_ticks: z
    .string()
    .optional()
    .default("1000")
    .transform((v) => parseInt(v, 10) || 1000),
  limit: z
    .string()
    .optional()
    .default("100")
    .transform((v) => Math.min(parseInt(v, 10) || 100, 1000)),
});

export const BacktestAssetsResponseSchema = z.object({
  assets: z.array(BacktestAssetSchema),
  count: z.number(),
  min_ticks_filter: z.number(),
});

// ============================================================
// Data Quality Response
// ============================================================

export const DataQualitySchema = z.object({
  total_ticks: z.number(),
  first_tick: z.string(),
  last_tick: z.string(),
  latency_percentiles: z.array(z.number()),
  resync_count: z.number(),
  expected_sequence_range: z.number(),
  unique_sequences: z.number(),
  sequence_gap_ratio: z.number(),
});

export const DataQualityResponseSchema = z.object({
  asset_id: AssetIdSchema,
  quality: DataQualitySchema,
});
