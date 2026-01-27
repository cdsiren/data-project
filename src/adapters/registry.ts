// src/adapters/registry.ts
// Adapter registry for multi-market support (~30 lines)

import type { MarketConnector } from "./base-connector";
import { PolymarketConnector } from "./polymarket/connector";
import { KalshiConnector } from "./kalshi/connector";

/**
 * Registry of market connectors by market source.
 * Lazy initialization to avoid loading unused adapters.
 */
const ADAPTERS: Record<string, () => MarketConnector> = {
  polymarket: () => new PolymarketConnector(),
  kalshi: () => new KalshiConnector(),
};

/**
 * Get a connector for the specified market source.
 * @param marketSource - Market source identifier (e.g., "polymarket", "kalshi")
 * @returns MarketConnector implementation
 * @throws Error if market source is not supported
 */
export function getConnector(marketSource: string): MarketConnector {
  const factory = ADAPTERS[marketSource];
  if (!factory) {
    throw new Error(`Unsupported market source: ${marketSource}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return factory();
}

/**
 * Check if a market source is supported.
 * @param marketSource - Market source identifier
 * @returns true if supported
 */
export function isMarketSupported(marketSource: string): boolean {
  return marketSource in ADAPTERS;
}

/**
 * Get list of supported market sources.
 * @returns Array of supported market source identifiers
 */
export function getSupportedMarkets(): string[] {
  return Object.keys(ADAPTERS);
}
