// src/schemas/triggers.ts
// Trigger-related Zod schemas for API validation

import { z } from "zod";
import {
  AssetIdSchema,
  ConditionIdSchema,
  TriggerIdSchema,
  MarketTypeSchema,
  createResponseSchema,
} from "./common";

// ============================================================
// Trigger Condition Types
// ============================================================

export const TriggerTypeSchema = z.enum([
  // Price triggers
  "PRICE_ABOVE",
  "PRICE_BELOW",
  "PRICE_MOVE",
  "MID_PRICE_TREND",
  // Spread triggers
  "SPREAD_WIDE",
  "SPREAD_NARROW",
  // Imbalance triggers
  "IMBALANCE_BID",
  "IMBALANCE_ASK",
  "IMBALANCE_SHIFT",
  // Size triggers
  "SIZE_SPIKE",
  "LARGE_FILL",
  // HFT triggers
  "MICROPRICE_DIVERGENCE",
  "QUOTE_VELOCITY",
  "STALE_QUOTE",
  // Arbitrage triggers
  "YES_NO_ARBITRAGE",
]);

export const TriggerSideSchema = z.enum(["BID", "ASK", "MID"]);

// ============================================================
// Trigger Condition Schema (polymorphic based on type)
// ============================================================

export const TriggerConditionSchema = z.object({
  type: TriggerTypeSchema,
  threshold: z.number(),
  side: TriggerSideSchema.optional(),
  window_ms: z.number().optional(),
});

// ============================================================
// Trigger Create Request
// ============================================================

export const TriggerCreateRequestSchema = z.object({
  asset_id: AssetIdSchema.or(z.literal("*")),
  condition_id: ConditionIdSchema.optional(),
  condition: TriggerConditionSchema,
  webhook_url: z.string(),
  cooldown_ms: z.number().min(1000).max(86400000).optional().default(10000),
  enabled: z.boolean().optional().default(true),
  market_type: MarketTypeSchema.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

// ============================================================
// Trigger Response Schema
// ============================================================

export const TriggerSchema = z.object({
  id: TriggerIdSchema,
  asset_id: AssetIdSchema.or(z.literal("*")),
  condition_id: ConditionIdSchema.optional(),
  condition: TriggerConditionSchema,
  webhook_url: z.string(),
  cooldown_ms: z.number(),
  enabled: z.boolean(),
  last_fired: z.string().nullable(),
  fire_count: z.number(),
  created_at: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const TriggerCreateResponseSchema = createResponseSchema(TriggerSchema);

// ============================================================
// Trigger List Response
// ============================================================

export const TriggerListResponseSchema = z.object({
  triggers: z.array(TriggerSchema),
  total: z.number(),
  shards: z.number(),
});

// ============================================================
// Trigger Delete Request
// ============================================================

export const TriggerDeleteRequestSchema = z.object({
  trigger_id: TriggerIdSchema,
  condition_id: ConditionIdSchema.optional(),
  asset_id: AssetIdSchema.optional(),
});

export const TriggerDeleteResponseSchema = z.object({
  deleted: z.boolean(),
  trigger_id: TriggerIdSchema,
});

// ============================================================
// Trigger Event Schema (for SSE streaming)
// ============================================================

export const TriggerEventSchema = z.object({
  event_id: z.string(),
  trigger_id: TriggerIdSchema,
  trigger_type: TriggerTypeSchema,
  asset_id: AssetIdSchema,
  condition_id: ConditionIdSchema.optional(),
  fired_at: z.string(),
  value: z.number(),
  threshold: z.number(),
  context: z.object({
    best_bid: z.number().optional(),
    best_ask: z.number().optional(),
    mid_price: z.number().optional(),
    spread_bps: z.number().optional(),
    bid_size: z.number().optional(),
    ask_size: z.number().optional(),
  }).optional(),
});
