// src/adapters/lifecycle/registry.ts
// Registry for market lifecycle adapters (mirrors connector registry pattern)

import type { MarketSource } from "../../core/enums";
import type { Env } from "../../types";
import type { MarketLifecycleAdapter } from "./base-lifecycle-adapter";
import { PolymarketLifecycleAdapter } from "./polymarket-lifecycle-adapter";

/**
 * Registry of lifecycle adapters by market source.
 * Lazy initialization to avoid loading unused adapters.
 */
/**
 * Registry of lifecycle adapters by market source.
 *
 * To add a new market:
 * 1. Create lifecycle adapter implementing MarketLifecycleAdapter
 * 2. Add "{market}" to MarketSource type in src/core/enums.ts
 * 3. Add factory to LIFECYCLE_ADAPTERS record below
 */
const LIFECYCLE_ADAPTERS: Record<string, (env: Env) => MarketLifecycleAdapter> = {
  polymarket: (env) => new PolymarketLifecycleAdapter(env),
};

/**
 * Get a lifecycle adapter for the specified market source.
 * @param marketSource - Market source identifier (e.g., "polymarket")
 * @param env - Worker environment bindings
 * @returns MarketLifecycleAdapter implementation
 * @throws Error if market source is not supported
 */
export function getLifecycleAdapter(
  marketSource: MarketSource,
  env: Env
): MarketLifecycleAdapter {
  const factory = LIFECYCLE_ADAPTERS[marketSource];
  if (!factory) {
    throw new Error(
      `Unsupported market source for lifecycle: ${marketSource}. Available: ${Object.keys(LIFECYCLE_ADAPTERS).join(", ")}`
    );
  }
  return factory(env);
}

/**
 * Check if a market source has a lifecycle adapter.
 * @param marketSource - Market source identifier
 * @returns true if supported
 */
export function hasLifecycleAdapter(marketSource: string): boolean {
  return marketSource in LIFECYCLE_ADAPTERS;
}

/**
 * Get list of market sources with lifecycle adapters.
 * @returns Array of supported market source identifiers
 */
export function getSupportedLifecycleMarkets(): string[] {
  return Object.keys(LIFECYCLE_ADAPTERS);
}
