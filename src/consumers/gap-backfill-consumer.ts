// src/consumers/gap-backfill-consumer.ts
// Handles gap recovery by fetching FULL L2 orderbook from REST API
// Reliability improvement: recovers both BBO and full depth data

import type { Env } from "../types";
import type {
  GapBackfillJob,
  BBOSnapshot,
  FullL2Snapshot,
} from "../types/orderbook";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import { MarketCleanupService } from "../services/market-cleanup";
import { classifyHttpError } from "../services/clickhouse-utils";
import { normalizeMarketInfo } from "../config/database";

interface CLOBBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  tick_size: string;
}

/**
 * Normalize condition_id to decimal format.
 * CLOB API returns hex (0x...), Gamma API returns decimal.
 * We standardize on decimal to match live data path.
 */
function normalizeConditionId(conditionId: string): string {
  if (conditionId.startsWith("0x")) {
    return BigInt(conditionId).toString();
  }
  return conditionId;
}

export async function gapBackfillConsumer(
  batch: MessageBatch<GapBackfillJob>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);

  for (const message of batch.messages) {
    const job = message.body;

    // Note: Cloudflare's retry mechanism handles max retries (5 per wrangler.toml)
    // Messages exceeding max_retries automatically go to dead-letter-queue

    try {
      // Fetch current orderbook from REST API
      const response = await fetch(
        `https://clob.polymarket.com/book?token_id=${job.asset_id}`
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const classified = classifyHttpError(response.status, body);

        if (classified.severity === "permanent") {
          // Market no longer exists (resolved) - clean up and don't retry
          // This is expected for resolved markets and not an error
          console.log(
            `[GapBackfill] Market ${job.asset_id.slice(0, 20)}... ${classified.message}, cleaning up`
          );
          // Use coordinated cleanup service to prevent race conditions
          // with scheduled handler (idempotent, won't duplicate work)
          const cleanupService = new MarketCleanupService(env, () => "");
          await cleanupService.cleanupAsset(job.asset_id);
          message.ack(); // Acknowledge - don't retry resolved markets
          continue;
        }

        if (!classified.shouldRetry) {
          // Client error - log and ack to prevent infinite retry
          console.error(`[GapBackfill] Non-retryable error for ${job.asset_id.slice(0, 20)}...: ${classified.message}`);
          message.ack();
          continue;
        }

        // Transient or rate limit - throw to trigger retry
        throw new Error(`CLOB API error: ${classified.message}`);
      }

      const book = (await response.json()) as CLOBBookResponse;
      const now = Date.now();
      const sourceTs = parseInt(book.timestamp);

      // Parse all bids and asks for full L2 snapshot
      const bids = book.bids.map((b) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      }));
      const asks = book.asks.map((a) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      }));

      // CRITICAL FIX: Polymarket returns bids ASCENDING (lowest first) and asks DESCENDING (highest first)
      // Best bid = HIGHEST bid price (max), Best ask = LOWEST ask price (min)
      const bestBidLevel = bids.length > 0
        ? bids.reduce((best, curr) => curr.price > best.price ? curr : best)
        : null;
      const bestAskLevel = asks.length > 0
        ? asks.reduce((best, curr) => curr.price < best.price ? curr : best)
        : null;

      const bestBid = bestBidLevel?.price ?? null;
      const bestAsk = bestAskLevel?.price ?? null;
      const bidSize = bestBidLevel?.size ?? null;
      const askSize = bestAskLevel?.size ?? null;
      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
      const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

      // Create BBO snapshot for tick-level data
      // Use normalizeMarketInfo for consistent defaulting
      const { source: marketSource, type: marketType } = normalizeMarketInfo(
        job.market_source,
        job.market_type
      );

      const bboSnapshot: BBOSnapshot = {
        market_source: marketSource,
        market_type: marketType,
        asset_id: book.asset_id,
        token_id: book.asset_id,
        condition_id: normalizeConditionId(book.market),
        source_ts: sourceTs,
        ingestion_ts: now * 1000,
        book_hash: book.hash,
        best_bid: bestBid,
        best_ask: bestAsk,
        bid_size: bidSize,
        ask_size: askSize,
        mid_price: midPrice,
        spread_bps: spreadBps,
        tick_size: parseFloat(book.tick_size),
        is_resync: true,
        sequence_number: sourceTs,
      };

      // Create full L2 snapshot for depth recovery
      const fullL2Snapshot: FullL2Snapshot = {
        market_source: marketSource,
        market_type: marketType,
        asset_id: book.asset_id,
        token_id: book.asset_id,
        condition_id: normalizeConditionId(book.market),
        source_ts: sourceTs,
        ingestion_ts: now * 1000,
        book_hash: book.hash,
        bids,
        asks,
        tick_size: parseFloat(book.tick_size),
        sequence_number: sourceTs,
      };

      // Queue both BBO and full L2 for complete recovery
      await Promise.all([
        env.SNAPSHOT_QUEUE.send(bboSnapshot),
        env.FULL_L2_QUEUE.send(fullL2Snapshot),
      ]);

      console.log(
        `[GapBackfill] Recovered ${job.asset_id} - ` +
        `${bids.length} bids, ${asks.length} asks`
      );
      message.ack();
    } catch (error) {
      console.error(
        `[GapBackfill] Failed for ${job.asset_id.slice(0, 20)}..., will retry:`,
        error
      );

      // Use Cloudflare's built-in retry mechanism instead of manual re-queue
      // This prevents message accumulation on repeated failures
      // Max retries (5) configured in wrangler.toml - exceeding goes to dead-letter-queue
      message.retry();
    }
  }
}
