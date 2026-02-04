// src/services/market-cache.ts
// Centralized service for market metadata cache operations
// Eliminates duplicate cache lookup logic across index.ts endpoints

import type { MarketSource } from "../core/enums";

/**
 * Market metadata stored in KV cache
 */
export interface MarketMetadata {
  condition_id: string;
  order_price_min_tick_size?: number;
  neg_risk?: boolean | number;
  order_min_size?: number;
  end_date?: string;
  question?: string;
  market_slug?: string;
  outcome?: string;
  // Add other fields as needed
}

/**
 * Result of a market metadata lookup
 */
export interface MarketMetadataResult {
  metadata: MarketMetadata | null;
  error?: string;
}

/**
 * Service for market metadata cache operations
 * Centralizes cache lookup logic to prevent duplication
 */
export class MarketCacheService {
  constructor(private cache: KVNamespace) {}

  /**
   * Get market metadata for an asset ID
   * Returns null if not found or invalid, with optional error message
   */
  async getMarketMetadata(assetId: string): Promise<MarketMetadataResult> {
    const cacheKey = `market:${assetId}`;

    try {
      const cached = await this.cache.get(cacheKey);

      if (!cached) {
        return { metadata: null };
      }

      const metadata = JSON.parse(cached) as MarketMetadata;

      // Validate required fields
      if (!metadata.condition_id) {
        return {
          metadata: null,
          error: `Missing condition_id in cache for asset ${assetId.slice(0, 20)}...`,
        };
      }

      return { metadata };
    } catch (error) {
      const errorMsg = `Failed to parse cache for asset ${assetId.slice(0, 20)}...: ${error}`;
      console.error(`[MarketCache] ${errorMsg}`);
      return { metadata: null, error: errorMsg };
    }
  }

  /**
   * Get just the condition_id for an asset
   * Convenience method for when only condition_id is needed
   */
  async getConditionId(assetId: string): Promise<string | null> {
    const result = await this.getMarketMetadata(assetId);
    return result.metadata?.condition_id ?? null;
  }

  /**
   * Check if a market has ended based on its end_date
   */
  async hasMarketEnded(assetId: string): Promise<boolean> {
    const result = await this.getMarketMetadata(assetId);
    if (!result.metadata?.end_date) {
      return false;
    }
    return new Date(result.metadata.end_date) < new Date();
  }

  /**
   * Get normalized market metadata with defaults
   * Useful for subscription handlers that need all fields
   */
  async getNormalizedMetadata(
    assetId: string
  ): Promise<{
    conditionId: string | null;
    tickSize: number;
    negRisk: boolean;
    orderMinSize: number;
    marketEnded: boolean;
    error?: string;
  }> {
    const result = await this.getMarketMetadata(assetId);

    if (!result.metadata) {
      return {
        conditionId: null,
        tickSize: 0.01,
        negRisk: false,
        orderMinSize: 0,
        marketEnded: false,
        error: result.error,
      };
    }

    const metadata = result.metadata;
    return {
      conditionId: metadata.condition_id,
      tickSize: metadata.order_price_min_tick_size ?? 0.01,
      negRisk: metadata.neg_risk === 1 || metadata.neg_risk === true,
      orderMinSize: metadata.order_min_size ?? 0,
      marketEnded: metadata.end_date ? new Date(metadata.end_date) < new Date() : false,
    };
  }
}
