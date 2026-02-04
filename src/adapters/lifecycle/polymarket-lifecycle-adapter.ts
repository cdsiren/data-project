// src/adapters/lifecycle/polymarket-lifecycle-adapter.ts
// Polymarket implementation of the lifecycle adapter

import type { MarketSource, MarketType } from "../../core/enums";
import type { Env, PolymarketMarket } from "../../types";
import type {
  MarketLifecycleAdapter,
  MarketLifecycleEvent,
  MarketMetadata,
} from "./base-lifecycle-adapter";

/**
 * Gamma API market response shape
 */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  closed: boolean;
  archived: boolean;
  active: boolean;
  enableOrderBook: boolean;
  clobTokenIds: string; // JSON array of token IDs
  negRisk: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  resolvedBy?: string;
  resolutionSource?: string;
  description?: string;
  category?: string;
}

/**
 * Parse token IDs from JSON string
 */
function parseTokenIds(clobTokenIds: string): string[] {
  try {
    return JSON.parse(clobTokenIds);
  } catch {
    return [clobTokenIds];
  }
}

/**
 * Format API error response for logging
 */
async function formatApiError(response: Response): Promise<string> {
  const errorText = await response.text().catch(() => "Unknown error");
  return `Gamma API returned ${response.status}: ${errorText}`;
}

/**
 * Polymarket lifecycle adapter.
 * Uses the Gamma API to fetch market data.
 */
export class PolymarketLifecycleAdapter implements MarketLifecycleAdapter {
  readonly marketSource: MarketSource = "polymarket";
  readonly marketType: MarketType = "prediction";

  private readonly gammaApiUrl: string;
  private readonly marketCache: KVNamespace;

  constructor(env: Env) {
    this.gammaApiUrl = env.GAMMA_API_URL;
    this.marketCache = env.MARKET_CACHE;
  }

  async fetchResolvedMarkets(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    const response = await fetch(
      `${this.gammaApiUrl}/markets?closed=true&limit=50&order=endDate&ascending=false`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`[PolymarketLifecycle] ${await formatApiError(response)}`);
    }

    const markets = (await response.json()) as GammaMarket[];

    for (const market of markets) {
      const cacheKey = `resolved:${market.conditionId}`;
      const alreadyNotified = await this.isAlreadyNotified(cacheKey);

      if (!alreadyNotified && market.closed) {
        const tokenIds = parseTokenIds(market.clobTokenIds);

        const event: MarketLifecycleEvent = {
          event_type: "MARKET_RESOLVED",
          market_id: market.id,
          condition_id: market.conditionId,
          question: market.question,
          slug: market.slug,
          token_ids: tokenIds,
          neg_risk: market.negRisk,
          detected_at: Date.now(),
          resolved_by: market.resolvedBy,
          resolution_source: market.resolutionSource,
        };

        events.push(event);

        // Mark as notified (24h TTL)
        await this.markAsNotified(cacheKey, 86400);
      }
    }

    if (events.length > 0) {
      console.log(`[PolymarketLifecycle] Found ${events.length} newly resolved markets`);
    }

    return events;
  }

  async fetchNewMarkets(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    const response = await fetch(
      `${this.gammaApiUrl}/markets?active=true&closed=false&limit=50&order=startDate&ascending=false`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`[PolymarketLifecycle] ${await formatApiError(response)}`);
    }

    const markets = (await response.json()) as GammaMarket[];

    for (const market of markets) {
      const cacheKey = `newmarket:${market.conditionId}`;
      const alreadyNotified = await this.isAlreadyNotified(cacheKey);

      if (!alreadyNotified && market.active && market.enableOrderBook) {
        const tokenIds = parseTokenIds(market.clobTokenIds);

        const event: MarketLifecycleEvent = {
          event_type: "NEW_MARKET",
          market_id: market.id,
          condition_id: market.conditionId,
          question: market.question,
          slug: market.slug,
          token_ids: tokenIds,
          neg_risk: market.negRisk,
          detected_at: Date.now(),
          end_date: market.endDate,
          tick_size: market.orderPriceMinTickSize,
          min_size: market.orderMinSize,
        };

        events.push(event);

        // Mark as notified (7 day TTL)
        await this.markAsNotified(cacheKey, 604800);
      }
    }

    if (events.length > 0) {
      console.log(`[PolymarketLifecycle] Found ${events.length} new markets`);
    }

    return events;
  }

  async fetchMarketDetails(conditionIds: string[]): Promise<MarketMetadata[]> {
    const params = conditionIds.map((id) => `condition_id=${id}`).join("&");
    const url = `${this.gammaApiUrl}/markets?${params}`;

    console.log(`[PolymarketLifecycle] Fetching market details for ${conditionIds.length} conditions`);

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`[PolymarketLifecycle] ${await formatApiError(response)}`);
    }

    const markets = (await response.json()) as PolymarketMarket[];
    return this.normalizeMarkets(markets);
  }

  async fetchAllActiveMarkets(limit: number = 100): Promise<MarketMetadata[]> {
    const allMarkets: PolymarketMarket[] = [];
    let offset = 0;
    let hasMore = true;

    console.log("[PolymarketLifecycle] Starting full market fetch...");

    while (hasMore) {
      try {
        const url = `${this.gammaApiUrl}/markets?active=true&closed=false&enableOrderBook=true&limit=${limit}&offset=${offset}`;

        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          console.error(`[PolymarketLifecycle] Gamma API error: ${response.status}`);
          break;
        }

        const markets = (await response.json()) as PolymarketMarket[];

        if (markets.length === 0) {
          hasMore = false;
        } else {
          allMarkets.push(...markets);
          offset += markets.length;

          // Safety limit
          if (offset >= 5000) {
            console.warn("[PolymarketLifecycle] Hit safety limit of 5000 markets");
            hasMore = false;
          }
        }
      } catch (error) {
        console.error(
          `[PolymarketLifecycle] Error fetching markets at offset ${offset} ` +
          `(fetched ${allMarkets.length} so far):`,
          error
        );
        break;
      }
    }

    console.log(`[PolymarketLifecycle] Fetched ${allMarkets.length} total active markets`);
    return this.normalizeMarkets(allMarkets);
  }

  async isAlreadyNotified(cacheKey: string): Promise<boolean> {
    const value = await this.marketCache.get(cacheKey);
    return value !== null;
  }

  async markAsNotified(cacheKey: string, ttlSeconds: number): Promise<void> {
    await this.marketCache.put(cacheKey, "1", { expirationTtl: ttlSeconds });
  }

  /**
   * Normalize Polymarket API response to canonical MarketMetadata
   */
  private normalizeMarkets(markets: PolymarketMarket[]): MarketMetadata[] {
    return markets.map((market) => ({
      id: market.id,
      question: market.question,
      conditionId: market.conditionId,
      slug: market.slug,
      endDate: market.endDate,
      startDate: market.startDate,
      createdAt: market.createdAt,
      submitted_by: market.submitted_by,
      resolvedBy: market.resolvedBy,
      resolutionSource: market.resolutionSource,
      restricted: market.restricted,
      enableOrderBook: market.enableOrderBook,
      orderPriceMinTickSize: market.orderPriceMinTickSize,
      orderMinSize: market.orderMinSize,
      clobTokenIds: market.clobTokenIds,
      negRisk: market.negRisk,
      negRiskMarketID: market.negRiskMarketID,
      negRiskRequestID: market.negRiskRequestID,
      description: market.description,
      category: market.category,
      events: market.events,
    }));
  }
}
