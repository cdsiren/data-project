// src/adapters/polymarket/metadata-provider.ts
// Polymarket metadata provider - fetches market data from Gamma API

import type { MarketSource } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";
import type { MarketMetadata, MarketLifecycleEvent } from "../../core/market-data";
import { BaseMetadataProvider, type MetadataFetchOptions } from "../base/metadata-provider";
import type { GammaMarket, PolymarketMarket, PolymarketCacheValue } from "./types";
import { normalizeMarketMetadata, buildPolymarketInstrumentID } from "./normalizers";

/**
 * Polymarket metadata provider
 * Fetches market metadata from Gamma API and caches in KV
 */
export class PolymarketMetadataProvider extends BaseMetadataProvider {
  readonly marketSource: MarketSource = "polymarket";

  private gammaApiUrl: string;
  private marketCache: KVNamespace | null = null;

  constructor(gammaApiUrl: string = "https://gamma-api.polymarket.com") {
    super();
    this.gammaApiUrl = gammaApiUrl;
  }

  async initialize(kvNamespace: KVNamespace): Promise<void> {
    await super.initialize(kvNamespace);
    this.marketCache = kvNamespace;
  }

  /**
   * Fetch metadata for multiple instruments from Gamma API
   */
  async fetchMetadata(
    nativeIds: string[],
    options?: MetadataFetchOptions
  ): Promise<Map<string, MarketMetadata>> {
    const results = new Map<string, MarketMetadata>();

    // Check cache first (unless force refresh)
    const toFetch: string[] = [];
    if (!options?.forceRefresh) {
      for (const nativeId of nativeIds) {
        const cached = await this.getCachedMetadata(nativeId);
        if (cached) {
          results.set(nativeId, cached);
        } else {
          toFetch.push(nativeId);
        }
      }
    } else {
      toFetch.push(...nativeIds);
    }

    if (toFetch.length === 0) {
      return results;
    }

    // Fetch from Gamma API
    // We need to look up condition_id for each token to query the API
    // Token IDs are asset_ids, API uses condition_id
    try {
      // First, try to get condition IDs from cache
      const conditionIds = new Set<string>();
      const tokenToCondition = new Map<string, string>();

      for (const tokenId of toFetch) {
        const cacheKey = `market:${tokenId}`;
        const cached = this.marketCache
          ? await this.marketCache.get(cacheKey, "json") as PolymarketCacheValue | null
          : null;
        if (cached?.condition_id) {
          conditionIds.add(cached.condition_id);
          tokenToCondition.set(tokenId, cached.condition_id);
        }
      }

      // Fetch markets by condition IDs
      if (conditionIds.size > 0) {
        const params = Array.from(conditionIds).map((id) => `condition_id=${id}`).join("&");
        const url = `${this.gammaApiUrl}/markets?${params}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), options?.timeoutMs || 10000);

        try {
          const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const markets = (await response.json()) as PolymarketMarket[];

            // Build metadata for each token
            for (const market of markets) {
              // Parse token IDs from clobTokenIds
              let tokenIds: string[] = [];
              try {
                tokenIds = JSON.parse(market.clobTokenIds);
              } catch {
                tokenIds = [market.clobTokenIds];
              }

              for (const tokenId of tokenIds) {
                if (toFetch.includes(tokenId)) {
                  const metadata = normalizeMarketMetadata(market, tokenId);
                  results.set(tokenId, metadata);
                }
              }
            }
          }
        } catch (error) {
          clearTimeout(timeoutId);
          console.error(`[PolymarketMetadata] Error fetching from Gamma API:`, error);
        }
      }
    } catch (error) {
      console.error(`[PolymarketMetadata] Error fetching metadata:`, error);
    }

    // Update cache with fetched metadata
    if (results.size > 0) {
      await this.updateCache(results);
    }

    return results;
  }

  /**
   * Poll for lifecycle events (resolutions and new markets)
   */
  async pollLifecycleEvents(sinceTimestamp?: number): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];
    const now = Date.now();

    // Check for resolved markets
    try {
      const resolvedEvents = await this.checkMarketResolutions();
      events.push(...resolvedEvents);
    } catch (error) {
      console.error(`[PolymarketMetadata] Error checking resolutions:`, error);
    }

    // Check for new markets
    try {
      const newMarketEvents = await this.checkNewMarkets();
      events.push(...newMarketEvents);
    } catch (error) {
      console.error(`[PolymarketMetadata] Error checking new markets:`, error);
    }

    return events;
  }

  /**
   * Check for recently resolved markets
   */
  private async checkMarketResolutions(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    try {
      const response = await fetch(
        `${this.gammaApiUrl}/markets?closed=true&limit=50&order=endDate&ascending=false`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        console.error(`[PolymarketMetadata] Gamma API error: ${response.status}`);
        return events;
      }

      const markets = (await response.json()) as GammaMarket[];

      for (const market of markets) {
        const cacheKey = `resolved:${market.conditionId}`;
        const alreadyNotified = this.marketCache
          ? await this.marketCache.get(cacheKey)
          : null;

        if (!alreadyNotified && market.closed) {
          // Parse token IDs
          let tokenIds: string[] = [];
          try {
            tokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            tokenIds = [market.clobTokenIds];
          }

          // Create event for each token
          for (const tokenId of tokenIds) {
            events.push({
              type: "MARKET_RESOLVED",
              marketSource: "polymarket",
              instrumentId: buildPolymarketInstrumentID(tokenId),
              timestamp: Date.now(),
              metadata: {
                condition_id: market.conditionId,
                question: market.question,
                resolved_by: market.resolvedBy,
                resolution_source: market.resolutionSource,
              },
            });
          }

          // Mark as notified (24h TTL)
          if (this.marketCache) {
            await this.marketCache.put(cacheKey, "1", { expirationTtl: 86400 });
          }
        }
      }
    } catch (error) {
      console.error(`[PolymarketMetadata] Error checking resolutions:`, error);
    }

    return events;
  }

  /**
   * Check for newly created markets
   */
  private async checkNewMarkets(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    try {
      const response = await fetch(
        `${this.gammaApiUrl}/markets?active=true&closed=false&limit=50&order=startDate&ascending=false`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        console.error(`[PolymarketMetadata] Gamma API error: ${response.status}`);
        return events;
      }

      const markets = (await response.json()) as GammaMarket[];

      for (const market of markets) {
        const cacheKey = `newmarket:${market.conditionId}`;
        const alreadyNotified = this.marketCache
          ? await this.marketCache.get(cacheKey)
          : null;

        if (!alreadyNotified && market.active && market.enableOrderBook) {
          // Parse token IDs
          let tokenIds: string[] = [];
          try {
            tokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            tokenIds = [market.clobTokenIds];
          }

          // Create event for each token
          for (const tokenId of tokenIds) {
            events.push({
              type: "MARKET_CREATED",
              marketSource: "polymarket",
              instrumentId: buildPolymarketInstrumentID(tokenId),
              timestamp: Date.now(),
              metadata: {
                condition_id: market.conditionId,
                question: market.question,
                end_date: market.endDate,
                tick_size: market.orderPriceMinTickSize,
                min_size: market.orderMinSize,
                neg_risk: market.negRisk,
              },
            });
          }

          // Mark as notified (7 day TTL)
          if (this.marketCache) {
            await this.marketCache.put(cacheKey, "1", { expirationTtl: 604800 });
          }
        }
      }
    } catch (error) {
      console.error(`[PolymarketMetadata] Error checking new markets:`, error);
    }

    return events;
  }

  /**
   * Get canonical instrument ID for a native token ID
   */
  async getInstrumentId(nativeId: string): Promise<InstrumentID | null> {
    return buildPolymarketInstrumentID(nativeId);
  }

  /**
   * Get market ID (condition_id) for a token ID
   */
  async getMarketId(nativeId: string): Promise<string | null> {
    if (!this.marketCache) return null;

    const cacheKey = `market:${nativeId}`;
    const cached = await this.marketCache.get(cacheKey, "json") as PolymarketCacheValue | null;
    return cached?.condition_id ?? null;
  }

  /**
   * Get related instruments (YES/NO pair for binary markets)
   */
  async getRelatedInstruments(marketId: string): Promise<string[]> {
    // Fetch market to get all token IDs
    try {
      const response = await fetch(
        `${this.gammaApiUrl}/markets?condition_id=${marketId}`,
        { headers: { Accept: "application/json" } }
      );

      if (response.ok) {
        const markets = (await response.json()) as PolymarketMarket[];
        if (markets.length > 0) {
          try {
            return JSON.parse(markets[0].clobTokenIds);
          } catch {
            return [markets[0].clobTokenIds];
          }
        }
      }
    } catch (error) {
      console.error(`[PolymarketMetadata] Error fetching related instruments:`, error);
    }

    return [];
  }

  /**
   * Update the Polymarket-specific cache format
   * This maintains compatibility with existing goldsky webhook
   */
  async updatePolymarketCache(
    markets: PolymarketMarket[],
    kvNamespace: KVNamespace
  ): Promise<void> {
    const operations: Promise<void>[] = [];

    for (const market of markets) {
      const cacheValue: PolymarketCacheValue = {
        condition_id: market.conditionId,
        order_price_min_tick_size: market.orderPriceMinTickSize,
        neg_risk: market.negRisk,
        order_min_size: market.orderMinSize,
        end_date: market.endDate,
      };

      // Parse token IDs and cache for each
      try {
        const tokenIds = JSON.parse(market.clobTokenIds) as string[];
        for (const tokenId of tokenIds) {
          operations.push(
            kvNamespace.put(`market:${tokenId}`, JSON.stringify(cacheValue), {
              expirationTtl: 86400 * 7, // 7 days
            })
          );
        }
      } catch {
        operations.push(
          kvNamespace.put(`market:${market.clobTokenIds}`, JSON.stringify(cacheValue), {
            expirationTtl: 86400 * 7,
          })
        );
      }
    }

    await Promise.allSettled(operations);
  }
}
