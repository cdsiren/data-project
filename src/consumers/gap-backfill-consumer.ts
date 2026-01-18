// src/consumers/gap-backfill-consumer.ts
// Handles gap recovery by fetching current orderbook from REST API

import type { Env } from "../types";
import type {
  GapBackfillJob,
  BBOSnapshot,
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

      // Create BBO-only resync snapshot
      const bestBid = book.bids[0] ? parseFloat(book.bids[0].price) : null;
      const bestAsk = book.asks[0] ? parseFloat(book.asks[0].price) : null;
      const bidSize = book.bids[0] ? parseFloat(book.bids[0].size) : null;
      const askSize = book.asks[0] ? parseFloat(book.asks[0].size) : null;
      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
      const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

      const snapshot: BBOSnapshot = {
        asset_id: book.asset_id,
        token_id: book.asset_id,
        condition_id: book.market,
        source_ts: parseInt(book.timestamp),
        ingestion_ts: Date.now() * 1000,
        book_hash: book.hash,
        best_bid: bestBid,
        best_ask: bestAsk,
        bid_size: bidSize,
        ask_size: askSize,
        mid_price: midPrice,
        spread_bps: spreadBps,
        tick_size: parseFloat(book.tick_size),
        is_resync: true,
        sequence_number: parseInt(book.timestamp),
      };

      // Queue for normal processing (will update hash chain)
      await env.SNAPSHOT_QUEUE.send(snapshot);

      console.log(`[GapBackfill] Recovered ${job.asset_id}`);
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
