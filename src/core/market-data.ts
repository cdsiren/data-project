// src/core/market-data.ts
// Canonical market metadata types for the multi-market trading framework

import type { MarketSource, MarketType, InstrumentType } from "./enums";
import type { InstrumentID } from "./instrument";

/**
 * Canonical market metadata (market-agnostic)
 * Adapters normalize market-specific metadata into this format
 *
 * Design follows CCXT's unified market structure pattern
 */
export interface MarketMetadata {
  // Identification
  instrumentId: InstrumentID;
  instrumentType: InstrumentType;
  marketSource: MarketSource;
  marketType: MarketType;

  // Native IDs (market-specific)
  nativeId: string;           // Token ID, ticker, address
  marketId: string;           // Condition ID, series ticker, pool address

  // Human-readable info
  question: string;           // Market question/description
  symbol?: string;            // Trading symbol if applicable

  // Trading parameters
  tickSize: number;
  minOrderSize: number;
  priceMin: number;           // Min valid price (0.0 for prediction markets)
  priceMax: number;           // Max valid price (1.0 for prediction markets)

  // Lifecycle
  startDate: string;          // ISO 8601
  endDate: string;            // ISO 8601
  active: boolean;
  resolved: boolean;

  // Market-specific extensions (JSON-serializable)
  // Examples:
  //   Polymarket: { neg_risk: true, counterpart_token_id: "..." }
  //   Kalshi: { strike_type: "atmost", floor_strike: 80000 }
  //   Uniswap: { token0: "0x...", token1: "0x...", fee_tier: 3000 }
  extensions: Record<string, unknown>;
}

/**
 * Market lifecycle events (new markets, resolutions, etc.)
 */
export type MarketLifecycleEventType =
  | "MARKET_CREATED"
  | "MARKET_ACTIVATED"
  | "MARKET_RESOLVED"
  | "MARKET_CLOSED"
  | "TICK_SIZE_CHANGED";

export interface MarketLifecycleEvent {
  type: MarketLifecycleEventType;
  marketSource: MarketSource;
  instrumentId: InstrumentID;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Credentials for market APIs (stored securely in env vars)
 */
export interface MarketCredentials {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  // Additional fields as needed per market
  [key: string]: string | undefined;
}

/**
 * Market configuration (loaded from wrangler.toml)
 */
export interface MarketConfig {
  marketSource: MarketSource;
  marketType: MarketType;
  enabled: boolean;
  wsUrl: string | null;
  restApiUrl: string;
  adapterClass: string;
  config: {
    maxInstrumentsPerWs: number | null;
    priceRange: [number, number];
    requiresAuthentication?: boolean;
    heartbeatIntervalMs?: number;
    shardingStrategy?: string;
    instrumentType?: InstrumentType;
    [key: string]: unknown;
  };
}

/**
 * Database record format for market metadata
 * Used for ClickHouse storage
 */
export interface MarketMetadataRecord {
  market_source: string;
  id: string;
  question: string;
  condition_id: string;
  slug: string;
  resolution_source: string;
  end_date: string;
  start_date: string;
  created_at: string;
  submitted_by: string;
  resolved_by: string;
  restricted: number;         // Boolean as 0/1 for ClickHouse
  enable_order_book: number;
  order_price_min_tick_size: number;
  order_min_size: number;
  clob_token_ids: string;
  neg_risk: number;
  neg_risk_market_id: string;
  neg_risk_request_id: string;
}
