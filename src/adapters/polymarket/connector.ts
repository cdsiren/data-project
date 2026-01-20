// src/adapters/polymarket/connector.ts
// Polymarket market connector - main entry point for Polymarket integration

import type { Env } from "../../types";
import type { MarketSource, MarketType, InstrumentType } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";
import type { MarketConfig } from "../../core/market-data";
import {
  BaseMarketConnector,
  type SubscriptionRequest,
  type SubscriptionResult,
} from "../base/connector";
import type { IMetadataProvider } from "../base/metadata-provider";
import type { IWebSocketHandler } from "../base/websocket-handler";
import type { IShardingStrategy } from "../base/sharding-strategy";
import type { ITriggerEvaluator } from "../base/trigger-evaluator";
import { PolymarketWebSocketHandler } from "./websocket-handler";
import { PolymarketMetadataProvider } from "./metadata-provider";
import { BinaryMarketShardingStrategy } from "./sharding-strategy";

/**
 * Polymarket connector
 * Implements the IMarketConnector interface for Polymarket integration
 */
export class PolymarketConnector extends BaseMarketConnector {
  readonly marketId: MarketSource = "polymarket";
  readonly marketType: MarketType = "prediction";
  readonly defaultInstrumentType: InstrumentType = "BINARY_OPTION";

  private wsHandler: PolymarketWebSocketHandler | null = null;
  private metadataProvider: PolymarketMetadataProvider | null = null;
  private shardingStrategy: BinaryMarketShardingStrategy | null = null;
  private triggerEvaluators: ITriggerEvaluator[] = [];

  async initialize(env: Env, config: MarketConfig): Promise<void> {
    await super.initialize(env, config);

    // Initialize WebSocket handler
    const wsUrl = config.wsUrl || env.CLOB_WSS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    const maxInstruments = config.config.maxInstrumentsPerWs ?? 500;
    const heartbeatInterval = config.config.heartbeatIntervalMs ?? 10000;

    this.wsHandler = new PolymarketWebSocketHandler(
      wsUrl,
      heartbeatInterval,
      maxInstruments
    );

    // Initialize metadata provider
    const gammaApiUrl = config.restApiUrl || env.GAMMA_API_URL || "https://gamma-api.polymarket.com";
    this.metadataProvider = new PolymarketMetadataProvider(gammaApiUrl);
    await this.metadataProvider.initialize(env.MARKET_CACHE);

    // Initialize sharding strategy
    const shardCount = 25; // Default Polymarket shard count
    const maxPerShard = (maxInstruments as number) - 50; // Leave headroom
    this.shardingStrategy = new BinaryMarketShardingStrategy(shardCount, maxPerShard);
    this.shardingStrategy.setMarketCache(env.MARKET_CACHE);

    // Trigger evaluators will be initialized separately
    // They need access to the full trigger system
  }

  getMetadataProvider(): IMetadataProvider {
    if (!this.metadataProvider) {
      throw new Error("PolymarketConnector not initialized - call initialize() first");
    }
    return this.metadataProvider;
  }

  getWebSocketHandler(): IWebSocketHandler {
    if (!this.wsHandler) {
      throw new Error("PolymarketConnector not initialized - call initialize() first");
    }
    return this.wsHandler;
  }

  getShardingStrategy(): IShardingStrategy {
    if (!this.shardingStrategy) {
      throw new Error("PolymarketConnector not initialized - call initialize() first");
    }
    return this.shardingStrategy;
  }

  getTriggerEvaluators(): ITriggerEvaluator[] {
    return this.triggerEvaluators;
  }

  /**
   * Set trigger evaluators (called after connector is initialized)
   */
  setTriggerEvaluators(evaluators: ITriggerEvaluator[]): void {
    this.triggerEvaluators = evaluators;
  }

  /**
   * Subscribe to instruments
   * Note: Actual WebSocket management is handled by OrderbookManager
   * This method validates and prepares the subscription
   */
  async subscribe(request: SubscriptionRequest): Promise<SubscriptionResult> {
    if (!this.initialized) {
      return {
        subscribed: [],
        failed: request.instruments.map((i) => ({
          instrument: i,
          reason: "Connector not initialized",
        })),
      };
    }

    const subscribed: InstrumentID[] = [];
    const failed: Array<{ instrument: InstrumentID; reason: string }> = [];

    for (const instrument of request.instruments) {
      // Basic validation - could add more checks
      if (!instrument || instrument.length === 0) {
        failed.push({ instrument, reason: "Invalid instrument ID" });
        continue;
      }

      subscribed.push(instrument);
    }

    return { subscribed, failed };
  }

  /**
   * Unsubscribe from instruments
   * Note: Polymarket requires closing connection to unsubscribe
   */
  async unsubscribe(_instruments: InstrumentID[]): Promise<void> {
    // Polymarket WebSocket doesn't support unsubscribe messages
    // Unsubscription is handled by removing from the connection's asset list
    // and sending a new subscription message
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.initialized || !this.metadataProvider) {
      return false;
    }

    // Try to fetch a market to verify API connectivity
    try {
      const response = await fetch(
        `${this.getRestApiUrl()}/markets?limit=1`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get condition_id for a token (Polymarket-specific helper)
   */
  async getConditionId(tokenId: string): Promise<string | null> {
    if (!this.metadataProvider) return null;
    return this.metadataProvider.getMarketId(tokenId);
  }

  /**
   * Pre-populate condition_id mapping for faster sharding
   */
  setConditionIdMapping(tokenId: string, conditionId: string): void {
    if (this.shardingStrategy) {
      this.shardingStrategy.setConditionId(tokenId, conditionId);
    }
  }
}
