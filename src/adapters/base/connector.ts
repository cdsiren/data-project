// src/adapters/base/connector.ts
// Market connector interface - inspired by CCXT unified API and Nautilus Trader DataClient

import type { Env } from "../../types";
import type { MarketSource, MarketType, InstrumentType } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";
import type { MarketConfig, MarketCredentials } from "../../core/market-data";
import type { IMetadataProvider } from "./metadata-provider";
import type { IWebSocketHandler } from "./websocket-handler";
import type { IShardingStrategy } from "./sharding-strategy";
import type { ITriggerEvaluator } from "./trigger-evaluator";

/**
 * Subscription request for real-time data
 */
export interface SubscriptionRequest {
  instruments: InstrumentID[];
  channels: ("book" | "trades" | "ticker")[];
}

/**
 * Result of subscription attempt
 */
export interface SubscriptionResult {
  subscribed: InstrumentID[];
  failed: Array<{ instrument: InstrumentID; reason: string }>;
}

/**
 * Connection state for a WebSocket
 */
export interface ConnectionState {
  id: string;
  marketSource: MarketSource;
  connected: boolean;
  subscribedInstruments: Set<InstrumentID>;
  lastHeartbeat: number;
  reconnectAttempts: number;
}

/**
 * Market connector interface
 * Each market (Polymarket, Kalshi, etc.) implements this interface
 *
 * Follows CCXT's unified API pattern where each exchange has
 * a connector that normalizes to common data structures
 */
export interface IMarketConnector {
  /** Market identifier (e.g., "polymarket", "kalshi") */
  readonly marketId: MarketSource;

  /** Market type (prediction, dex, cex) */
  readonly marketType: MarketType;

  /** Default instrument type for this market */
  readonly defaultInstrumentType: InstrumentType;

  /**
   * Initialize connector (load config, validate credentials, etc.)
   * Called once at startup per market
   *
   * @param env - Cloudflare Worker environment bindings
   * @param config - Market configuration from MARKETS_CONFIG
   */
  initialize(env: Env, config: MarketConfig): Promise<void>;

  /**
   * Get the metadata provider for this market
   * Handles fetching and caching instrument metadata
   */
  getMetadataProvider(): IMetadataProvider;

  /**
   * Get the WebSocket handler for this market
   * Handles WS message parsing and normalization
   */
  getWebSocketHandler(): IWebSocketHandler;

  /**
   * Get the sharding strategy for this market
   * Determines how instruments are distributed across shards
   */
  getShardingStrategy(): IShardingStrategy;

  /**
   * Get trigger evaluators for this market
   * Returns array of evaluators (generic + market-specific)
   */
  getTriggerEvaluators(): ITriggerEvaluator[];

  /**
   * Get credentials for this market (from env)
   */
  getCredentials(): MarketCredentials | null;

  /**
   * Subscribe to real-time data for instruments
   * Returns subscribed instruments (may differ from requested if some failed)
   *
   * @param request - Subscription request with instruments and channels
   */
  subscribe(request: SubscriptionRequest): Promise<SubscriptionResult>;

  /**
   * Unsubscribe from instruments
   *
   * @param instruments - Instruments to unsubscribe from
   */
  unsubscribe(instruments: InstrumentID[]): Promise<void>;

  /**
   * Health check - returns true if connector is operational
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get WebSocket URL for this market
   */
  getWebSocketUrl(): string | null;

  /**
   * Get REST API base URL for this market
   */
  getRestApiUrl(): string;

  /**
   * Check if this market requires authentication
   */
  requiresAuthentication(): boolean;
}

/**
 * Base class for market connectors with common functionality
 */
export abstract class BaseMarketConnector implements IMarketConnector {
  abstract readonly marketId: MarketSource;
  abstract readonly marketType: MarketType;
  abstract readonly defaultInstrumentType: InstrumentType;

  protected env!: Env;
  protected config!: MarketConfig;
  protected initialized = false;

  async initialize(env: Env, config: MarketConfig): Promise<void> {
    this.env = env;
    this.config = config;
    this.initialized = true;
  }

  abstract getMetadataProvider(): IMetadataProvider;
  abstract getWebSocketHandler(): IWebSocketHandler;
  abstract getShardingStrategy(): IShardingStrategy;
  abstract getTriggerEvaluators(): ITriggerEvaluator[];

  getCredentials(): MarketCredentials | null {
    return null; // Override in subclasses that need auth
  }

  abstract subscribe(request: SubscriptionRequest): Promise<SubscriptionResult>;
  abstract unsubscribe(instruments: InstrumentID[]): Promise<void>;

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  getWebSocketUrl(): string | null {
    return this.config?.wsUrl ?? null;
  }

  getRestApiUrl(): string {
    return this.config?.restApiUrl ?? "";
  }

  requiresAuthentication(): boolean {
    return this.config?.config?.requiresAuthentication ?? false;
  }
}
