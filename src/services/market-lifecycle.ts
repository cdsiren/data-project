// src/services/market-lifecycle.ts
// Polls Gamma API for market resolution and new market events
// These are not available via WebSocket, so we poll periodically
// Also syncs market metadata to ClickHouse on 5-minute cron

import type { Env, PolymarketMarket, MarketMetadataRecord, MarketEventRecord } from "../types";
import { buildSyncInsertUrlWithColumns } from "./clickhouse-client";
import { WebhookSigner } from "./webhook-signer";
import { DB_CONFIG } from "../config/database";

/**
 * Retry configuration for ClickHouse operations
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000, // 1s, 2s, 4s with exponential backoff
} as const;

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < RETRY_CONFIG.maxAttempts) {
        const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[MarketLifecycle] ${context} failed (attempt ${attempt}/${RETRY_CONFIG.maxAttempts}), retrying in ${delayMs}ms:`,
          lastError.message
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

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
}

interface MarketLifecycleEvent {
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

interface MarketLifecycleWebhook {
  url: string;
  secret?: string;
  event_types: ("MARKET_RESOLVED" | "NEW_MARKET")[];
}

export class MarketLifecycleService {
  private env: Env;
  private webhooks: MarketLifecycleWebhook[] = [];

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Register a webhook to receive market lifecycle events
   */
  registerWebhook(webhook: MarketLifecycleWebhook): void {
    this.webhooks.push(webhook);
  }

  /**
   * Poll for market resolution events
   * Checks markets that have closed since the last check
   */
  async checkMarketResolutions(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    try {
      // Get recently closed markets from Gamma API
      const response = await fetch(
        `${this.env.GAMMA_API_URL}/markets?closed=true&limit=50&order=endDate&ascending=false`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        console.error(`[MarketLifecycle] Gamma API error: ${response.status}`);
        return events;
      }

      const markets = (await response.json()) as GammaMarket[];

      // Check each closed market against our cache
      for (const market of markets) {
        const cacheKey = `resolved:${market.conditionId}`;
        const alreadyNotified = await this.env.MARKET_CACHE.get(cacheKey);

        if (!alreadyNotified && market.closed) {
          // Parse token IDs
          let tokenIds: string[] = [];
          try {
            tokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            tokenIds = [market.clobTokenIds];
          }

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
          await this.env.MARKET_CACHE.put(cacheKey, "1", { expirationTtl: 86400 });
        }
      }

      if (events.length > 0) {
        console.log(`[MarketLifecycle] Found ${events.length} newly resolved markets`);
      }
    } catch (error) {
      console.error("[MarketLifecycle] Error checking resolutions:", error);
    }

    return events;
  }

  /**
   * Poll for new market events
   * Checks for markets created since the last check
   */
  async checkNewMarkets(): Promise<MarketLifecycleEvent[]> {
    const events: MarketLifecycleEvent[] = [];

    try {
      // Get recently created active markets from Gamma API
      const response = await fetch(
        `${this.env.GAMMA_API_URL}/markets?active=true&closed=false&limit=50&order=startDate&ascending=false`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        console.error(`[MarketLifecycle] Gamma API error: ${response.status}`);
        return events;
      }

      const markets = (await response.json()) as GammaMarket[];

      // Check each market against our cache
      for (const market of markets) {
        const cacheKey = `newmarket:${market.conditionId}`;
        const alreadyNotified = await this.env.MARKET_CACHE.get(cacheKey);

        if (!alreadyNotified && market.active && market.enableOrderBook) {
          // Parse token IDs
          let tokenIds: string[] = [];
          try {
            tokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            tokenIds = [market.clobTokenIds];
          }

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

          // Mark as notified (7 day TTL - longer since markets don't get "re-created")
          await this.env.MARKET_CACHE.put(cacheKey, "1", { expirationTtl: 604800 });
        }
      }

      if (events.length > 0) {
        console.log(`[MarketLifecycle] Found ${events.length} new markets`);
      }
    } catch (error) {
      console.error("[MarketLifecycle] Error checking new markets:", error);
    }

    return events;
  }

  /**
   * Dispatch events to registered webhooks (parallel execution)
   */
  async dispatchEvents(events: MarketLifecycleEvent[]): Promise<void> {
    const dispatchPromises: Promise<void>[] = [];

    for (const event of events) {
      for (const webhook of this.webhooks) {
        // Check if this webhook wants this event type
        if (!webhook.event_types.includes(event.event_type)) continue;

        // Create a promise for each webhook dispatch
        dispatchPromises.push(
          (async () => {
            try {
              const body = JSON.stringify(event);
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "X-Event-Type": event.event_type,
              };

              // Add HMAC signature if secret is configured (using shared utility)
              await WebhookSigner.addSignatureHeader(headers, body, webhook.secret);

              const response = await fetch(webhook.url, {
                method: "POST",
                headers,
                body,
              });

              if (!response.ok) {
                console.error(
                  `[MarketLifecycle] Webhook ${webhook.url} failed: ${response.status} ${await response.text()}`
                );
              } else {
                console.log(
                  `[MarketLifecycle] Dispatched ${event.event_type} for ${event.condition_id}`
                );
              }
            } catch (error) {
              console.error(`[MarketLifecycle] Webhook ${webhook.url} error:`, error);
            }
          })()
        );
      }
    }

    // Execute all webhooks in parallel
    await Promise.allSettled(dispatchPromises);
  }

  /**
   * Run a full lifecycle check (called from scheduled handler)
   * Returns resolutionEvents to allow caller to unsubscribe resolved markets
   * Returns newMarketEvents to allow caller to subscribe new markets to orderbook monitoring
   */
  async runCheck(): Promise<{
    resolutions: number;
    new_markets: number;
    metadata_synced: number;
    resolutionEvents: MarketLifecycleEvent[];
    newMarketEvents: MarketLifecycleEvent[];
  }> {
    const [resolutionEvents, newMarketEvents] = await Promise.all([
      this.checkMarketResolutions(),
      this.checkNewMarkets(),
    ]);

    const allEvents = [...resolutionEvents, ...newMarketEvents];

    if (allEvents.length > 0) {
      await this.dispatchEvents(allEvents);
    }

    // Sync metadata to ClickHouse for new markets
    let metadataSynced = 0;
    if (newMarketEvents.length > 0) {
      const conditionIds = newMarketEvents.map((e) => e.condition_id);
      const fullMarkets = await fetchFullMarketDetails(this.env, conditionIds);

      if (fullMarkets.length > 0) {
        try {
          await insertMarketsIntoClickHouse(fullMarkets, this.env);
          await updateMarketCache(fullMarkets, this.env);
          metadataSynced = fullMarkets.length;
        } catch (error) {
          console.error("[MarketLifecycle] Failed to sync metadata:", error);
          // Non-fatal: cache misses will use defaults, metadata will retry on next cron
        }
      }
    }

    return {
      resolutions: resolutionEvents.length,
      new_markets: newMarketEvents.length,
      metadata_synced: metadataSynced,
      resolutionEvents, // Return for unsubscribe processing
      newMarketEvents, // Return for subscribe processing
    };
  }
}

/**
 * Fetch full market details from Gamma API for new markets
 */
async function fetchFullMarketDetails(
  env: Env,
  conditionIds: string[]
): Promise<PolymarketMarket[]> {
  if (conditionIds.length === 0) return [];

  try {
    // Fetch markets by condition IDs
    const params = conditionIds.map((id) => `condition_id=${id}`).join("&");
    const url = `${env.GAMMA_API_URL}/markets?${params}`;

    console.log(`[MarketLifecycle] Fetching full market details: ${url}`);

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error(`[MarketLifecycle] Gamma API error: ${response.status}`);
      return [];
    }

    const markets = (await response.json()) as PolymarketMarket[];
    return markets;
  } catch (error) {
    console.error("[MarketLifecycle] Error fetching market details:", error);
    return [];
  }
}

/**
 * Insert market metadata into ClickHouse
 */
async function insertMarketsIntoClickHouse(
  markets: PolymarketMarket[],
  env: Env
): Promise<void> {
  if (markets.length === 0) return;

  const metadataRecords: MarketMetadataRecord[] = [];
  const eventRecords: MarketEventRecord[] = [];

  // Transform Polymarket data to ClickHouse records
  for (const market of markets) {
    metadataRecords.push({
      id: market.id,
      question: market.question,
      condition_id: market.conditionId,
      slug: market.slug,
      resolution_source: market.resolutionSource || "",
      end_date: market.endDate,
      start_date: market.startDate,
      created_at: market.createdAt,
      submitted_by: market.submitted_by,
      resolved_by: market.resolvedBy || "",
      restricted: market.restricted ? 1 : 0,
      enable_order_book: market.enableOrderBook ? 1 : 0,
      order_price_min_tick_size: market.orderPriceMinTickSize,
      order_min_size: market.orderMinSize,
      clob_token_ids: market.clobTokenIds,
      neg_risk: market.negRisk ? 1 : 0,
      neg_risk_market_id: market.negRiskMarketID || "",
      neg_risk_request_id: market.negRiskRequestID || "",
    });

    // Extract events
    for (const event of market.events) {
      eventRecords.push({
        event_id: event.id,
        market_id: market.id,
        title: event.title,
      });
    }
  }

  // Insert metadata and events in parallel
  const insertPromises: Promise<void>[] = [];

  if (metadataRecords.length > 0) {
    insertPromises.push(
      insertIntoClickHouse(env, "market_metadata", metadataRecords, [
        "id", "question", "condition_id", "slug", "resolution_source",
        "end_date", "start_date", "created_at", "submitted_by", "resolved_by",
        "restricted", "enable_order_book", "order_price_min_tick_size",
        "order_min_size", "clob_token_ids", "neg_risk",
        "neg_risk_market_id", "neg_risk_request_id",
      ]).then(() => {
        console.log(`[MarketLifecycle] Inserted ${metadataRecords.length} market metadata records`);
      })
    );
  }

  if (eventRecords.length > 0) {
    insertPromises.push(
      insertIntoClickHouse(env, "market_events", eventRecords, [
        "event_id", "market_id", "title",
      ]).then(() => {
        console.log(`[MarketLifecycle] Inserted ${eventRecords.length} event records`);
      })
    );
  }

  await Promise.all(insertPromises);
}

/**
 * Insert records into ClickHouse using SYNCHRONOUS insert with retry.
 *
 * Uses wait_for_async_insert=1 to guarantee data persistence before returning.
 * Includes exponential backoff retry for transient failures.
 */
async function insertIntoClickHouse(
  env: Env,
  table: string,
  records: unknown[],
  columns: string[]
): Promise<void> {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  // Use SYNC insert (wait_for_async_insert=1) for guaranteed persistence
  const url = buildSyncInsertUrlWithColumns(env.CLICKHOUSE_URL, table, columns);

  await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": env.CLICKHOUSE_USER || "default",
        "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
        "Content-Type": "application/x-ndjson",
      },
      body: body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `ClickHouse insert failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    console.log(
      `[MarketLifecycle] Successfully inserted ${records.length} records into ${DB_CONFIG.DATABASE}.${table}`
    );
  }, `insert into ${table}`);
}

/**
 * Update KV cache with market metadata for each token ID (parallel execution)
 */
async function updateMarketCache(
  markets: PolymarketMarket[],
  env: Env
): Promise<void> {
  const cacheOperations: Promise<void>[] = [];

  for (const market of markets) {
    // Build cache value with fields needed by goldsky webhook
    const cacheValue = JSON.stringify({
      condition_id: market.conditionId,
      order_price_min_tick_size: market.orderPriceMinTickSize,
      neg_risk: market.negRisk,
      order_min_size: market.orderMinSize,
      end_date: market.endDate,
    });

    // Parse clob_token_ids and cache for each token
    try {
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      for (const tokenId of tokenIds) {
        cacheOperations.push(
          env.MARKET_CACHE.put(`market:${tokenId}`, cacheValue, {
            expirationTtl: 86400 * 7, // 7 days
          })
        );
      }
    } catch {
      // If clobTokenIds is not JSON array, cache with the raw value
      cacheOperations.push(
        env.MARKET_CACHE.put(
          `market:${market.clobTokenIds}`,
          cacheValue,
          { expirationTtl: 86400 * 7 }
        )
      );
    }
  }

  // Execute all cache operations in parallel
  const results = await Promise.allSettled(cacheOperations);
  const failures = results.filter((r) => r.status === "rejected");

  if (failures.length > 0) {
    console.error(
      `[MarketLifecycle] ${failures.length}/${cacheOperations.length} cache updates failed`
    );
  } else {
    console.log(`[MarketLifecycle] Updated KV cache for ${markets.length} markets`);
  }
}

/**
 * Fetch ALL active markets from Gamma API for full metadata refresh.
 * Used by periodic refresh to ensure stale data doesn't accumulate.
 *
 * @param env - Environment bindings
 * @param limit - Max markets to fetch per page (default 100)
 * @returns Array of all active markets
 */
async function fetchAllActiveMarkets(
  env: Env,
  limit: number = 100
): Promise<PolymarketMarket[]> {
  const allMarkets: PolymarketMarket[] = [];
  let offset = 0;
  let hasMore = true;

  console.log("[MarketLifecycle] Starting full market metadata fetch...");

  while (hasMore) {
    try {
      const url = `${env.GAMMA_API_URL}/markets?active=true&closed=false&enableOrderBook=true&limit=${limit}&offset=${offset}`;

      const response = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        console.error(`[MarketLifecycle] Gamma API error: ${response.status}`);
        break;
      }

      const markets = (await response.json()) as PolymarketMarket[];

      if (markets.length === 0) {
        hasMore = false;
      } else {
        allMarkets.push(...markets);
        offset += markets.length;

        // Safety limit to prevent infinite loops
        if (offset >= 5000) {
          console.warn("[MarketLifecycle] Hit safety limit of 5000 markets");
          hasMore = false;
        }
      }
    } catch (error) {
      console.error("[MarketLifecycle] Error fetching markets:", error);
      break;
    }
  }

  console.log(`[MarketLifecycle] Fetched ${allMarkets.length} total active markets`);
  return allMarkets;
}

/**
 * Refresh ALL active market metadata in ClickHouse.
 * Call this periodically (e.g., hourly) to ensure metadata stays fresh.
 *
 * Uses ReplacingMergeTree deduplication - existing records with same
 * (condition_id, id) key will be replaced with newer versions on merge.
 *
 * @param env - Environment bindings
 * @returns Number of markets refreshed
 */
async function refreshAllMarketMetadata(env: Env): Promise<number> {
  console.log("[MarketLifecycle] Starting periodic metadata refresh...");

  const markets = await fetchAllActiveMarkets(env);

  if (markets.length === 0) {
    console.warn("[MarketLifecycle] No active markets found for refresh");
    return 0;
  }

  // Insert in batches to avoid overwhelming ClickHouse
  const BATCH_SIZE = 100;
  let totalRefreshed = 0;

  for (let i = 0; i < markets.length; i += BATCH_SIZE) {
    const batch = markets.slice(i, i + BATCH_SIZE);

    try {
      await insertMarketsIntoClickHouse(batch, env);
      await updateMarketCache(batch, env);
      totalRefreshed += batch.length;

      console.log(
        `[MarketLifecycle] Refreshed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} markets (${totalRefreshed}/${markets.length} total)`
      );
    } catch (error) {
      console.error(
        `[MarketLifecycle] Failed to refresh batch at offset ${i}:`,
        error
      );
      // Continue with next batch - partial refresh is better than no refresh
    }
  }

  console.log(`[MarketLifecycle] Periodic refresh complete: ${totalRefreshed}/${markets.length} markets refreshed`);
  return totalRefreshed;
}

export { insertMarketsIntoClickHouse, updateMarketCache, refreshAllMarketMetadata };
export type { MarketLifecycleEvent, MarketLifecycleWebhook };
