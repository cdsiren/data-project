// src/schemas/index.ts
// Barrel export for all API schemas

// Common schemas
export {
  // Branded type schemas
  AssetIdSchema,
  ConditionIdSchema,
  TriggerIdSchema,
  // Pagination
  PaginationQuerySchema,
  PaginationResponseSchema,
  // Error handling
  ErrorCodeSchema,
  ErrorDetailSchema,
  ErrorResponseSchema,
  // Response meta
  ResponseMetaSchema,
  createResponseSchema,
  // Enums
  MarketSourceSchema,
  MarketTypeSchema,
  UserTierSchema,
  // Price schemas
  PriceLevelSchema,
  CurrentPriceSchema,
  Stats24hSchema,
  // Types
  type UserTier,
} from "./common";

// Market schemas
export {
  MarketListQuerySchema,
  MarketListItemSchema,
  MarketListResponseSchema,
  MarketDetailSchema,
  MarketDetailResponseSchema,
  OrderbookResponseSchema,
  MarketSearchQuerySchema,
  MarketSearchResponseSchema,
} from "./markets";

// Trigger schemas
export {
  TriggerTypeSchema,
  TriggerSideSchema,
  TriggerConditionSchema,
  TriggerCreateRequestSchema,
  TriggerSchema,
  TriggerCreateResponseSchema,
  TriggerListResponseSchema,
  TriggerDeleteRequestSchema,
  TriggerDeleteResponseSchema,
  TriggerEventSchema,
} from "./triggers";

// OHLC schemas
export {
  OHLCIntervalSchema,
  OHLCQuerySchema,
  OHLCCandleSchema,
  OHLCResponseSchema,
  OHLCExtendedCandleSchema,
  OHLCExtendedResponseSchema,
} from "./ohlc";

// Backtest schemas
export {
  BacktestGranularitySchema,
  BacktestExportQuerySchema,
  BacktestTickSchema,
  BacktestOHLCSchema,
  BacktestExportResponseSchema,
  BacktestAssetSchema,
  BacktestAssetsQuerySchema,
  BacktestAssetsResponseSchema,
  DataQualitySchema,
  DataQualityResponseSchema,
} from "./backtest";
