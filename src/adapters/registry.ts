// src/adapters/registry.ts
// Market adapter registry - central management of market connectors

import type { Env } from "../types";
import type { MarketSource, MarketType } from "../core/enums";
import type { MarketConfig } from "../core/market-data";
import type { IMarketConnector } from "./base/connector";
import { PolymarketConnector } from "./polymarket/connector";

/**
 * Market adapter factory function type
 */
type AdapterFactory = () => IMarketConnector;

/**
 * Registry entry for an adapter
 */
interface AdapterEntry {
  connector: IMarketConnector;
  config: MarketConfig;
  initialized: boolean;
}

/**
 * Market adapter registry
 * Manages all market connectors and provides lookup by market source
 */
export class MarketAdapterRegistry {
  private adapters: Map<MarketSource, AdapterEntry> = new Map();
  private factories: Map<string, AdapterFactory> = new Map();
  private env: Env | null = null;

  constructor() {
    // Register built-in adapter factories
    this.registerFactory("PolymarketConnector", () => new PolymarketConnector());
    // Future: this.registerFactory("KalshiConnector", () => new KalshiConnector());
  }

  /**
   * Register an adapter factory
   */
  registerFactory(className: string, factory: AdapterFactory): void {
    this.factories.set(className, factory);
  }

  /**
   * Initialize registry with environment and configs
   */
  async initialize(env: Env, configs: MarketConfig[]): Promise<void> {
    this.env = env;

    for (const config of configs) {
      if (!config.enabled) {
        console.log(`[AdapterRegistry] Skipping disabled market: ${config.marketSource}`);
        continue;
      }

      const factory = this.factories.get(config.adapterClass);
      if (!factory) {
        console.error(`[AdapterRegistry] Unknown adapter class: ${config.adapterClass}`);
        continue;
      }

      try {
        const connector = factory();
        await connector.initialize(env, config);

        this.adapters.set(config.marketSource, {
          connector,
          config,
          initialized: true,
        });

        console.log(`[AdapterRegistry] Initialized adapter: ${config.marketSource}`);
      } catch (error) {
        console.error(`[AdapterRegistry] Failed to initialize ${config.marketSource}:`, error);
      }
    }
  }

  /**
   * Get adapter by market source
   */
  get(marketSource: MarketSource): IMarketConnector | null {
    const entry = this.adapters.get(marketSource);
    if (!entry || !entry.initialized) {
      return null;
    }
    return entry.connector;
  }

  /**
   * Get adapter by market source (throws if not found)
   */
  getOrThrow(marketSource: MarketSource): IMarketConnector {
    const adapter = this.get(marketSource);
    if (!adapter) {
      throw new Error(`Adapter not found for market: ${marketSource}`);
    }
    return adapter;
  }

  /**
   * Get all adapters of a specific market type
   */
  getByMarketType(marketType: MarketType): IMarketConnector[] {
    const result: IMarketConnector[] = [];
    for (const entry of this.adapters.values()) {
      if (entry.initialized && entry.connector.marketType === marketType) {
        result.push(entry.connector);
      }
    }
    return result;
  }

  /**
   * Get all initialized adapters
   */
  getAll(): IMarketConnector[] {
    const result: IMarketConnector[] = [];
    for (const entry of this.adapters.values()) {
      if (entry.initialized) {
        result.push(entry.connector);
      }
    }
    return result;
  }

  /**
   * Get all enabled market sources
   */
  getEnabledMarkets(): MarketSource[] {
    return Array.from(this.adapters.keys()).filter(
      (market) => this.adapters.get(market)?.initialized
    );
  }

  /**
   * Check if a market source is registered and initialized
   */
  has(marketSource: MarketSource): boolean {
    const entry = this.adapters.get(marketSource);
    return entry?.initialized ?? false;
  }

  /**
   * Get config for a market
   */
  getConfig(marketSource: MarketSource): MarketConfig | null {
    return this.adapters.get(marketSource)?.config ?? null;
  }

  /**
   * Health check all adapters
   */
  async healthCheckAll(): Promise<Map<MarketSource, boolean>> {
    const results = new Map<MarketSource, boolean>();

    for (const [market, entry] of this.adapters) {
      if (entry.initialized) {
        try {
          const healthy = await entry.connector.healthCheck();
          results.set(market, healthy);
        } catch {
          results.set(market, false);
        }
      }
    }

    return results;
  }

  /**
   * Register a pre-built connector (for testing or custom connectors)
   */
  register(connector: IMarketConnector, config: MarketConfig): void {
    this.adapters.set(connector.marketId, {
      connector,
      config,
      initialized: true,
    });
  }
}

/**
 * Default registry instance
 * Can be replaced with custom registry for testing
 */
let defaultRegistry: MarketAdapterRegistry | null = null;

/**
 * Get the default registry instance
 */
export function getDefaultRegistry(): MarketAdapterRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new MarketAdapterRegistry();
  }
  return defaultRegistry;
}

/**
 * Set a custom registry instance (for testing)
 */
export function setDefaultRegistry(registry: MarketAdapterRegistry): void {
  defaultRegistry = registry;
}
