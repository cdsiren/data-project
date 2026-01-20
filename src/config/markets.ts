// src/config/markets.ts
// Market configuration loader

import type { MarketSource, MarketType, InstrumentType } from "../core/enums";
import type { MarketConfig } from "../core/market-data";

/**
 * Raw market config from wrangler.toml (JSON string)
 */
export interface RawMarketConfig {
  market_source: string;
  market_type: string;
  enabled: boolean;
  ws_url: string | null;
  rest_api_url: string;
  adapter_class: string;
  config: {
    max_instruments_per_ws?: number | null;
    price_range?: [number, number];
    requires_authentication?: boolean;
    heartbeat_interval_ms?: number;
    sharding_strategy?: string;
    instrument_type?: string;
    [key: string]: unknown;
  };
}

/**
 * Parse market configs from environment variable
 */
export function loadMarketConfigs(marketsConfigJson: string | undefined): MarketConfig[] {
  if (!marketsConfigJson) {
    // Default to Polymarket only
    return [getDefaultPolymarketConfig()];
  }

  try {
    const rawConfigs = JSON.parse(marketsConfigJson) as RawMarketConfig[];
    return rawConfigs.map(normalizeMarketConfig);
  } catch (error) {
    console.error("[MarketConfig] Failed to parse MARKETS_CONFIG:", error);
    // Fallback to Polymarket default
    return [getDefaultPolymarketConfig()];
  }
}

/**
 * Normalize raw config to typed MarketConfig
 */
function normalizeMarketConfig(raw: RawMarketConfig): MarketConfig {
  return {
    marketSource: raw.market_source as MarketSource,
    marketType: raw.market_type as MarketType,
    enabled: raw.enabled,
    wsUrl: raw.ws_url,
    restApiUrl: raw.rest_api_url,
    adapterClass: raw.adapter_class,
    config: {
      maxInstrumentsPerWs: raw.config.max_instruments_per_ws ?? null,
      priceRange: raw.config.price_range ?? [0, 1],
      requiresAuthentication: raw.config.requires_authentication,
      heartbeatIntervalMs: raw.config.heartbeat_interval_ms,
      shardingStrategy: raw.config.sharding_strategy,
      instrumentType: raw.config.instrument_type as InstrumentType | undefined,
      ...raw.config,
    },
  };
}

/**
 * Default Polymarket configuration
 */
export function getDefaultPolymarketConfig(): MarketConfig {
  return {
    marketSource: "polymarket",
    marketType: "prediction",
    enabled: true,
    wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    restApiUrl: "https://gamma-api.polymarket.com",
    adapterClass: "PolymarketConnector",
    config: {
      maxInstrumentsPerWs: 500,
      priceRange: [0, 1],
      requiresAuthentication: false,
      heartbeatIntervalMs: 10000,
      shardingStrategy: "binary_market",
      instrumentType: "BINARY_OPTION",
      supportsNegRisk: true,
    },
  };
}

/**
 * Default Kalshi configuration (disabled by default)
 */
export function getDefaultKalshiConfig(): MarketConfig {
  return {
    marketSource: "kalshi",
    marketType: "prediction",
    enabled: false,
    wsUrl: "wss://trading-api.kalshi.com/trade-api/ws/v2",
    restApiUrl: "https://trading-api.kalshi.com/trade-api/v2",
    adapterClass: "KalshiConnector",
    config: {
      maxInstrumentsPerWs: 100,
      priceRange: [0, 1],
      requiresAuthentication: true,
      heartbeatIntervalMs: 30000,
      shardingStrategy: "multi_outcome",
      instrumentType: "MULTI_OUTCOME",
    },
  };
}

/**
 * Get all default market configs
 */
export function getAllDefaultConfigs(): MarketConfig[] {
  return [
    getDefaultPolymarketConfig(),
    getDefaultKalshiConfig(),
  ];
}

/**
 * Validate a market config
 */
export function validateMarketConfig(config: MarketConfig): string[] {
  const errors: string[] = [];

  if (!config.marketSource) {
    errors.push("marketSource is required");
  }

  if (!config.marketType) {
    errors.push("marketType is required");
  }

  if (!config.adapterClass) {
    errors.push("adapterClass is required");
  }

  if (!config.restApiUrl) {
    errors.push("restApiUrl is required");
  }

  if (config.config.priceRange) {
    const [min, max] = config.config.priceRange;
    if (min >= max) {
      errors.push("priceRange[0] must be less than priceRange[1]");
    }
  }

  return errors;
}
