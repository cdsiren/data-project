// src/adapters/registry.ts
// Adapter registry for multi-market support
// To add a new market: implement MarketConnector interface, add to ADAPTERS record

import type { MarketConnector } from "./base-connector";
import { PolymarketConnector } from "./polymarket/connector";

/**
 * Registry of market connectors by market source.
 * Lazy initialization to avoid loading unused adapters.
 *
 * To add a new market:
 * 1. Create src/adapters/{market}/connector.ts implementing MarketConnector
 * 2. Create src/adapters/{market}/types.ts for market-specific types
 * 3. Add "{market}" to MarketSource type in src/core/enums.ts
 * 4. Add factory to ADAPTERS record below
 */
const ADAPTERS: Record<string, () => MarketConnector> = {
  polymarket: () => new PolymarketConnector(),
};

/**
 * Get a connector for the specified market source.
 * @param marketSource - Market source identifier (e.g., "polymarket")
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
