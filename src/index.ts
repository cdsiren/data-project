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
  const event: GoldskyTradeEvent = await c.req.json();

  // TODO: Extract condition_id from token_id or event data
  const conditionId = "STUB_CONDITION_ID";

  // Check cache for market metadata
  const cacheKey = `market:${conditionId}`;
  const cached = await c.env.MARKET_CACHE.get(cacheKey);

  if (!cached) {
    // Queue metadata fetch on cache miss
    const job: MetadataFetchJob = {
      condition_id: conditionId,
      token_id: event.token_id,
    };
    c.executionCtx.waitUntil(c.env.METADATA_QUEUE.send(job));
  }

  // Trigger Durable Object subscription
  const doId = c.env.ORDERBOOK_MANAGER.idFromName(conditionId);
  const doStub = c.env.ORDERBOOK_MANAGER.get(doId);

  c.executionCtx.waitUntil(
    doStub.fetch("https://stub/subscribe", {
      method: "POST",
      body: JSON.stringify({
        condition_id: conditionId,
        token_id: event.token_id,
      }),
    })
  );

  return c.json({ status: "ok" });
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
