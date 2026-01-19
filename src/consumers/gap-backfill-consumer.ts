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

const MAX_RETRIES = 3;

interface CLOBBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  tick_size: string;
}

export async function gapBackfillConsumer(
  batch: MessageBatch<GapBackfillJob>,
  env: Env
): Promise<void> {
  const clickhouse = new ClickHouseOrderbookClient(env);

  for (const message of batch.messages) {
    const job = message.body;

    if (job.retry_count >= MAX_RETRIES) {
      console.error(`[GapBackfill] Max retries reached for ${job.asset_id}`);
      await clickhouse.recordGapEvent(
        job.asset_id,
        job.last_known_hash,
        "UNKNOWN",
        Date.now() - job.gap_detected_at
      );
      message.ack();
      continue;
    }

    try {
      // Fetch current orderbook from REST API
      const response = await fetch(
        `https://clob.polymarket.com/book?token_id=${job.asset_id}`
      );

      if (!response.ok) {
        throw new Error(`CLOB API error: ${response.status}`);
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

      // Extract BBO from parsed data
      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;
      const bidSize = bids[0]?.size ?? null;
      const askSize = asks[0]?.size ?? null;
      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
      const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

      // Create BBO snapshot for tick-level data
      const bboSnapshot: BBOSnapshot = {
        asset_id: book.asset_id,
        token_id: book.asset_id,
        condition_id: book.market,
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
        asset_id: book.asset_id,
        token_id: book.asset_id,
        condition_id: book.market,
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
        `[GapBackfill] Attempt ${job.retry_count + 1} failed for ${
          job.asset_id
        }:`,
        error
      );

      // Requeue with incremented retry
      await env.GAP_BACKFILL_QUEUE.send({
        ...job,
        retry_count: job.retry_count + 1,
      });

      message.ack();
    }
  }
}
