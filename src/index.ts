import { Hono } from "hono";
import {
  Env,
  GoldskyTradeEvent,
  MetadataFetchJob,
  OrderbookSnapshot,
} from "./types";
import { OrderbookManager } from "./durable-objects/orderbook-manager";
import { metadataConsumer } from "./consumers/metadata-consumer";
import { snapshotConsumer } from "./consumers/snapshot-consumer";

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/goldsky", async (c) => {
  // Verify API key
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.WEBHOOK_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();

  // Handle both single event and array of events
  const events: GoldskyTradeEvent[] = Array.isArray(body) ? body : [body];

  console.log(`Received ${events.length} events from Goldsky`);

  const queuedJobs: string[] = [];

  for (const event of events) {
    // Extract active asset ID (the one that's not "0")
    const activeAssetId = event.maker_asset_id !== "0"
      ? event.maker_asset_id
      : event.taker_asset_id;

    // Check cache for market metadata using clob_token_id
    const cacheKey = `market:${activeAssetId}`;
    const cached = await c.env.MARKET_CACHE.get(cacheKey);

    if (!cached) {
      // Queue metadata fetch on cache miss
      const job: MetadataFetchJob = {
        clob_token_id: activeAssetId,
      };
      c.executionCtx.waitUntil(c.env.METADATA_QUEUE.send(job));
      queuedJobs.push(activeAssetId);
    }
  }

  return c.json({
    status: "ok",
    events_received: events.length,
    jobs_queued: queuedJobs.length,
    cached: events.length - queuedJobs.length
  });
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Export Durable Object
export { OrderbookManager };

async function queueHandler(batch: MessageBatch, env: Env) {
  const queueName = batch.queue;

  if (queueName === "metadata-fetch-queue") {
    await metadataConsumer(batch as MessageBatch<MetadataFetchJob>, env);
  } else if (queueName === "orderbook-snapshot-queue") {
    await snapshotConsumer(batch as MessageBatch<OrderbookSnapshot>, env);
  }
}

export default {
  fetch: app.fetch,
  queue: queueHandler,
};
