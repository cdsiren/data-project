// src/services/market-lifecycle.ts
// Polls market lifecycle APIs for resolution and new market events
// Also triggers data archival for resolved markets

import type { Env, MarketMetadataRecord, MarketEventRecord, ArchiveJob } from "../types";
import { buildSyncInsertUrlWithColumns } from "./clickhouse-client";
import { WebhookSigner } from "./webhook-signer";
import { DB_CONFIG } from "../config/database";
import type { MarketSource } from "../core/enums";
import {
  getLifecycleAdapter,
  type MarketLifecycleAdapter,
  type MarketLifecycleEvent,
  type MarketMetadata,
} from "../adapters/lifecycle";

interface MarketLifecycleWebhook {
  url: string;
  secret?: string;
  event_types: ("MARKET_RESOLVED" | "NEW_MARKET")[];
}

const MAX_DESCRIPTION_LENGTH = 10000;

export class MarketLifecycleService {
  private env: Env;
  private adapter: MarketLifecycleAdapter;
  private webhooks: MarketLifecycleWebhook[] = [];

  constructor(env: Env, marketSource: MarketSource = "polymarket") {
    this.env = env;
    this.adapter = getLifecycleAdapter(marketSource, env);
  }

  registerWebhook(webhook: MarketLifecycleWebhook): void {
    this.webhooks.push(webhook);
  }

  async checkMarketResolutions(): Promise<MarketLifecycleEvent[]> {
    try {
      return await this.adapter.fetchResolvedMarkets();
    } catch (error) {
      console.error("[MarketLifecycle] Failed to fetch resolved markets:", error);
      throw error;
    }
  }

  async checkNewMarkets(): Promise<MarketLifecycleEvent[]> {
    try {
      return await this.adapter.fetchNewMarkets();
    } catch (error) {
      console.error("[MarketLifecycle] Failed to fetch new markets:", error);
      throw error;
    }
  }

  async dispatchEvents(events: MarketLifecycleEvent[]): Promise<void> {
    const dispatchPromises = events.flatMap((event) =>
      this.webhooks
        .filter((webhook) => webhook.event_types.includes(event.event_type))
        .map((webhook) => this.dispatchToWebhook(event, webhook))
    );
    await Promise.allSettled(dispatchPromises);
  }

  private async dispatchToWebhook(
    event: MarketLifecycleEvent,
    webhook: MarketLifecycleWebhook
  ): Promise<void> {
    try {
      const body = JSON.stringify(event);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Event-Type": event.event_type,
      };
      await WebhookSigner.addSignatureHeader(headers, body, webhook.secret);

      const response = await fetch(webhook.url, { method: "POST", headers, body });
      if (!response.ok) {
        console.error(
          `[MarketLifecycle] Webhook ${webhook.url} failed with status ${response.status} ` +
          `for event ${event.event_type} (market: ${event.market_id}, condition: ${event.condition_id})`
        );
      }
    } catch (error) {
      console.error(
        `[MarketLifecycle] Webhook ${webhook.url} error for event ${event.event_type} ` +
        `(market: ${event.market_id}, condition: ${event.condition_id}):`,
        error
      );
    }
  }

  async runCheck(): Promise<{
    resolutions: number;
    new_markets: number;
    metadata_synced: number;
    archives_queued: number;
    resolutionEvents: MarketLifecycleEvent[];
    newMarketEvents: MarketLifecycleEvent[];
  }> {
    const [resolutionEvents, newMarketEvents] = await Promise.all([
      this.checkMarketResolutions(),
      this.checkNewMarkets(),
    ]);

    if (resolutionEvents.length + newMarketEvents.length > 0) {
      await this.dispatchEvents([...resolutionEvents, ...newMarketEvents]);
    }

    let metadataSynced = 0;
    if (newMarketEvents.length > 0) {
      const conditionIds = newMarketEvents.map((e) => e.condition_id);
      const fullMarkets = await this.adapter.fetchMarketDetails(conditionIds);

      if (fullMarkets.length > 0) {
        try {
          await insertMarketsIntoClickHouse(fullMarkets, this.env);
          await updateMarketCache(fullMarkets, this.env);
          metadataSynced = fullMarkets.length;
        } catch (error) {
          console.error("[MarketLifecycle] Failed to sync metadata:", error);
        }
      }
    }

    // Queue archive jobs for markets ready for archival (end_date > 7 days ago)
    let archivesQueued = 0;
    try {
      archivesQueued = await this.queueArchivableMarkets();
    } catch (error) {
      console.error("[MarketLifecycle] Failed to queue archive jobs:", error);
    }

    return {
      resolutions: resolutionEvents.length,
      new_markets: newMarketEvents.length,
      metadata_synced: metadataSynced,
      archives_queued: archivesQueued,
      resolutionEvents,
      newMarketEvents,
    };
  }

  /**
   * Find markets ready for archival and queue archive jobs.
   * Markets are ready when their end_date is more than 7 days in the past
   * and they haven't been archived yet.
   */
  async queueArchivableMarkets(): Promise<number> {
    // Query for markets ready to archive
    const query = `
      SELECT DISTINCT mm.condition_id
      FROM ${DB_CONFIG.DATABASE}.market_metadata mm
      WHERE mm.end_date < NOW() - INTERVAL 7 DAY
        AND mm.end_date != toDateTime64('1970-01-01 00:00:00', 3, 'UTC')
        AND mm.condition_id NOT IN (
          SELECT DISTINCT condition_id
          FROM ${DB_CONFIG.DATABASE}.archive_log
          WHERE archive_type = 'resolved'
        )
      LIMIT 50
      FORMAT JSON
    `;

    const url = new URL(this.env.CLICKHOUSE_URL);
    url.searchParams.set("query", query);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[MarketLifecycle] Archive query failed:", errorText);
        return 0;
      }

      const result = (await response.json()) as {
        data: Array<{ condition_id: string }>;
      };

      if (result.data.length === 0) {
        return 0;
      }

      // Queue archive jobs
      const queue = this.env.ARCHIVE_QUEUE;
      for (const { condition_id } of result.data) {
        const job: ArchiveJob = {
          type: "resolved",
          conditionId: condition_id,
        };
        await queue.send(job);
        console.log(`[MarketLifecycle] Queued archive job for market ${condition_id.slice(0, 20)}...`);
      }

      console.log(`[MarketLifecycle] Queued ${result.data.length} archive jobs`);
      return result.data.length;
    } catch (error) {
      console.error("[MarketLifecycle] Failed to query archivable markets:", error);
      return 0;
    }
  }
}

async function insertMarketsIntoClickHouse(
  markets: MarketMetadata[],
  env: Env
): Promise<void> {
  if (markets.length === 0) return;

  const metadataRecords: MarketMetadataRecord[] = [];
  const eventRecords: MarketEventRecord[] = [];

  for (const market of markets) {
    metadataRecords.push({
      id: market.id,
      question: market.question,
      condition_id: market.conditionId,
      slug: market.slug,
      resolution_source: market.resolutionSource || "",
      end_date: market.endDate,
      start_date: market.startDate || "",
      created_at: market.createdAt || "",
      submitted_by: market.submitted_by || "",
      resolved_by: market.resolvedBy || "",
      restricted: market.restricted ? 1 : 0,
      enable_order_book: market.enableOrderBook ? 1 : 0,
      order_price_min_tick_size: market.orderPriceMinTickSize,
      order_min_size: market.orderMinSize,
      clob_token_ids: market.clobTokenIds,
      neg_risk: market.negRisk ? 1 : 0,
      neg_risk_market_id: market.negRiskMarketID || "",
      neg_risk_request_id: market.negRiskRequestID || "",
      description: (market.description || "").slice(0, MAX_DESCRIPTION_LENGTH),
      category: market.category || "",
    });

    for (const event of market.events) {
      eventRecords.push({
        event_id: event.id,
        market_id: market.id,
        title: event.title,
        slug: event.slug || "",
        description: event.description || "",
      });
    }
  }

  const insertPromises: Promise<void>[] = [];

  if (metadataRecords.length > 0) {
    insertPromises.push(
      insertIntoClickHouse(env, "market_metadata", metadataRecords, [
        "id", "question", "condition_id", "slug", "resolution_source",
        "end_date", "start_date", "created_at", "submitted_by", "resolved_by",
        "restricted", "enable_order_book", "order_price_min_tick_size",
        "order_min_size", "clob_token_ids", "neg_risk",
        "neg_risk_market_id", "neg_risk_request_id", "description", "category",
      ])
    );
  }

  if (eventRecords.length > 0) {
    insertPromises.push(
      insertIntoClickHouse(env, "market_events", eventRecords, [
        "event_id", "market_id", "title", "slug", "description",
      ])
    );
  }

  await Promise.all(insertPromises);
}

async function insertIntoClickHouse(
  env: Env,
  table: string,
  records: unknown[],
  columns: string[]
): Promise<void> {
  const body = records.map(r => JSON.stringify(r)).join("\n");
  const url = buildSyncInsertUrlWithColumns(env.CLICKHOUSE_URL, table, columns);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": env.CLICKHOUSE_USER || "default",
      "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
      "Content-Type": "application/x-ndjson",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse insert failed: ${response.status} - ${errorText}`);
  }

  console.log(`[MarketLifecycle] Inserted ${records.length} records into ${DB_CONFIG.DATABASE}.${table}`);
}

async function updateMarketCache(markets: MarketMetadata[], env: Env): Promise<void> {
  const cacheOperations: Promise<void>[] = [];

  for (const market of markets) {
    const cacheValue = JSON.stringify({
      condition_id: market.conditionId,
      order_price_min_tick_size: market.orderPriceMinTickSize,
      neg_risk: market.negRisk,
      order_min_size: market.orderMinSize,
      end_date: market.endDate,
    });

    try {
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      for (const tokenId of tokenIds) {
        cacheOperations.push(
          env.MARKET_CACHE.put(`market:${tokenId}`, cacheValue, { expirationTtl: 86400 * 7 })
        );
      }
    } catch {
      console.warn(
        `[MarketLifecycle] Failed to parse clobTokenIds for market ${market.id} ` +
        `(condition: ${market.conditionId}), using raw value: ${market.clobTokenIds.slice(0, 50)}...`
      );
      cacheOperations.push(
        env.MARKET_CACHE.put(`market:${market.clobTokenIds}`, cacheValue, { expirationTtl: 86400 * 7 })
      );
    }
  }

  const results = await Promise.allSettled(cacheOperations);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`[MarketLifecycle] ${failures.length}/${cacheOperations.length} cache updates failed`);
  }
}

async function refreshAllMarketMetadata(
  env: Env,
  marketSource: MarketSource = "polymarket"
): Promise<number> {
  console.log("[MarketLifecycle] Starting periodic metadata refresh...");

  const adapter = getLifecycleAdapter(marketSource, env);
  const markets = await adapter.fetchAllActiveMarkets();

  if (markets.length === 0) {
    console.warn("[MarketLifecycle] No active markets found for refresh");
    return 0;
  }

  const BATCH_SIZE = 100;
  let totalRefreshed = 0;

  for (let i = 0; i < markets.length; i += BATCH_SIZE) {
    const batch = markets.slice(i, i + BATCH_SIZE);
    try {
      await insertMarketsIntoClickHouse(batch, env);
      await updateMarketCache(batch, env);
      totalRefreshed += batch.length;
    } catch (error) {
      console.error(`[MarketLifecycle] Failed to refresh batch at offset ${i}:`, error);
    }
  }

  console.log(`[MarketLifecycle] Refresh complete: ${totalRefreshed}/${markets.length} markets`);
  return totalRefreshed;
}

export { insertMarketsIntoClickHouse, updateMarketCache, refreshAllMarketMetadata };
export type { MarketLifecycleEvent, MarketLifecycleWebhook, MarketMetadata };
