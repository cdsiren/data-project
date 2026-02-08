// src/schemas/markets.ts
// Market-related Zod schemas for API validation

import { z } from "zod";
import {
  AssetIdSchema,
  ConditionIdSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  MarketSourceSchema,
  MarketTypeSchema,
  CurrentPriceSchema,
  Stats24hSchema,
  PriceLevelSchema,
  createResponseSchema,
} from "./common";

// ============================================================
// Market List Query Parameters
// ============================================================

export const MarketListQuerySchema = PaginationQuerySchema.extend({
  market_source: z.string().optional(),
  active: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  category: z.string().optional(),
});

// ============================================================
// Market List Item Schema (summary view)
// ============================================================

export const MarketListItemSchema = z.object({
  asset_id: AssetIdSchema,
  condition_id: ConditionIdSchema,
  question: z.string(),
  market_source: MarketSourceSchema,
  market_type: MarketTypeSchema,
  category: z.string().nullable(),
  neg_risk: z.boolean(),
  end_date: z.string().nullable(),
  tick_count: z.number(),
  last_tick: z.string().nullable(),
});

// ============================================================
// Market List Response
// ============================================================

export const MarketListResponseSchema = z.object({
  data: z.array(MarketListItemSchema),
  pagination: PaginationResponseSchema,
  timestamp: z.string(),
});

// ============================================================
// Market Detail Schema (single market with live data)
// ============================================================

export const MarketDetailSchema = z.object({
  asset_id: AssetIdSchema,
  condition_id: ConditionIdSchema,
  question: z.string(),
  description: z.string().nullable(),
  market_source: MarketSourceSchema,
  market_type: MarketTypeSchema,
  category: z.string().nullable(),
  neg_risk: z.boolean(),
  end_date: z.string().nullable(),
  current_price: CurrentPriceSchema.nullable(),
  stats_24h: Stats24hSchema.nullable(),
});

export const MarketDetailResponseSchema = createResponseSchema(MarketDetailSchema);

// ============================================================
// Market Orderbook Response
// ============================================================

export const OrderbookResponseSchema = z.object({
  asset_id: AssetIdSchema,
  timestamp: z.string(),
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  spread_bps: z.number(),
});

// ============================================================
// Market Search Query & Response
// ============================================================

export const MarketSearchQuerySchema = z.object({
  q: z.string().min(2),
  limit: z
    .string()
    .optional()
    .default("20")
    .transform((v) => Math.min(parseInt(v, 10) || 20, 100)),
});

export const MarketSearchResponseSchema = z.object({
  data: z.array(MarketListItemSchema),
  query: z.string(),
  total: z.number(),
});

// ============================================================
// Path Parameter Schemas
// ============================================================

export const AssetIdParamSchema = z.object({
  asset_id: z.string().min(1),
});

// ============================================================
// Inferred Types
// ============================================================

export type MarketListQuery = z.infer<typeof MarketListQuerySchema>;
export type MarketListItem = z.infer<typeof MarketListItemSchema>;
export type MarketDetail = z.infer<typeof MarketDetailSchema>;
export type MarketSearchQuery = z.infer<typeof MarketSearchQuerySchema>;
export type OrderbookResponse = z.infer<typeof OrderbookResponseSchema>;
