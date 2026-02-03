// src/adapters/lifecycle/base-lifecycle-adapter.ts
// Base interface for market lifecycle adapters (resolution detection, new market discovery)

import type { MarketSource, MarketType } from "../../core/enums";

/**
 * Market lifecycle event - normalized across all market sources
 */
export interface MarketLifecycleEvent {
  event_type: "MARKET_RESOLVED" | "NEW_MARKET";
  market_id: string;
  condition_id: string;
  question: string;
  slug: string;
  token_ids: string[];
  neg_risk: boolean;
  detected_at: number;

  // Resolution-specific fields
  resolved_by?: string;
  resolution_source?: string;

  // New market-specific fields
  end_date?: string;
  tick_size?: number;
  min_size?: number;
}

/**
 * Market metadata for ClickHouse sync
 */
export interface MarketMetadata {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  startDate?: string;
  createdAt?: string;
  submitted_by?: string;
  resolvedBy?: string;
  resolutionSource?: string;
  restricted?: boolean;
  enableOrderBook: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  clobTokenIds: string;
  negRisk: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  description?: string;
  category?: string;
  events: Array<{
    id: string;
    title: string;
    slug?: string;
    description?: string;
  }>;
}

/**
 * Market lifecycle adapter interface.
 * Implementations normalize market-specific lifecycle APIs to canonical types.
 *
 * Similar to MarketConnector for WebSocket data, this abstracts the REST API
 * interactions for market discovery and resolution detection.
 */
export interface MarketLifecycleAdapter {
  /** Market source identifier (e.g., "polymarket") */
  readonly marketSource: MarketSource;

  /** Market type (e.g., "prediction") */
  readonly marketType: MarketType;

  /**
   * Fetch recently resolved/closed markets.
   * Used to detect market resolutions and trigger cleanup.
   * @returns Array of resolution events
   */
  fetchResolvedMarkets(): Promise<MarketLifecycleEvent[]>;

  /**
   * Fetch newly created active markets.
   * Used to discover new markets for subscription.
   * @returns Array of new market events
   */
  fetchNewMarkets(): Promise<MarketLifecycleEvent[]>;

  /**
   * Fetch full market details for the given condition IDs.
   * Used to sync complete metadata to ClickHouse and cache.
   * @param conditionIds - Array of condition IDs to fetch
   * @returns Array of full market metadata
   */
  fetchMarketDetails(conditionIds: string[]): Promise<MarketMetadata[]>;

  /**
   * Fetch all active markets (for bootstrap/refresh).
   * @param limit - Maximum markets per page
   * @returns Array of all active market metadata
   */
  fetchAllActiveMarkets(limit?: number): Promise<MarketMetadata[]>;

  /**
   * Check if a market has been notified (cached).
   * @param cacheKey - Cache key to check
   * @returns true if already notified
   */
  isAlreadyNotified(cacheKey: string): Promise<boolean>;

  /**
   * Mark a market as notified.
   * @param cacheKey - Cache key to set
   * @param ttlSeconds - Time-to-live in seconds
   */
  markAsNotified(cacheKey: string, ttlSeconds: number): Promise<void>;
}
