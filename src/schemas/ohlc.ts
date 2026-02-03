// src/schemas/ohlc.ts
// OHLC (candlestick) data Zod schemas

import { z } from "zod";
import { AssetIdSchema } from "./common";

// ============================================================
// OHLC Query Parameters
// ============================================================

export const OHLCIntervalSchema = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);

export const OHLCQuerySchema = z.object({
  interval: z
    .string()
    .optional()
    .default("1m")
    .transform((v) => {
      const valid = ["1m", "5m", "15m", "1h", "4h", "1d"];
      return valid.includes(v) ? v : "1m";
    }),
  hours: z
    .string()
    .optional()
    .default("24")
    .transform((v) => Math.min(Math.max(parseInt(v, 10) || 24, 1), 720)),
});

// ============================================================
// OHLC Candlestick Schema
// ============================================================

export const OHLCCandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

// ============================================================
// OHLC Response Schema
// ============================================================

export const OHLCResponseSchema = z.object({
  data: z.array(OHLCCandleSchema),
  asset_id: AssetIdSchema,
  interval: z.string(),
  hours: z.number(),
});

// ============================================================
// Extended OHLC with additional metrics
// ============================================================

export const OHLCExtendedCandleSchema = OHLCCandleSchema.extend({
  vwap: z.number().optional(),
  avg_spread_bps: z.number().optional(),
  avg_imbalance: z.number().optional(),
  total_bid_volume: z.number().optional(),
  total_ask_volume: z.number().optional(),
});

export const OHLCExtendedResponseSchema = z.object({
  data: z.array(OHLCExtendedCandleSchema),
  asset_id: AssetIdSchema,
  interval: z.string(),
  hours: z.number(),
  extended: z.literal(true),
});
