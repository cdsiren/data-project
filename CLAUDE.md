# Polymarket Data Enrichment Pipeline

Cloudflare Workers project for enriching on-chain Polymarket data with market metadata and orderbook snapshots.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│  Goldsky Webhook                                                                │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────┐      ┌─────────────────────┐      ┌──────────────────┐   │
│  │ POST /webhook   │─────▶│ metadata-fetch-queue │─────▶│ Metadata Consumer│   │
│  │ (Event Handler) │      └─────────────────────┘      │ • Fetch Gamma API│   │
│  └────────┬────────┘                                   │ • Cache in KV    │   │
│           │                                            │ • Write CH       │   │
│           │ trigger DO                                 └──────────────────┘   │
│           ▼                                                                    │
│  ┌─────────────────┐      ┌─────────────────────┐      ┌──────────────────┐   │
│  │ OrderbookManager│─────▶│orderbook-snapshot-q │─────▶│ Snapshot Consumer│   │
│  │ Durable Object  │      └─────────────────────┘      │ • Write CH       │   │
│  │ • WS to CLOB    │                                   │ • Archive to R2  │   │
│  │ • Alarm snapshot│                                   └──────────────────┘   │
│  └─────────────────┘                                                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
polymarket-enrichment/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Main entry: Hono routes + queue handler exports
│   ├── durable-objects/
│   │   └── orderbook-manager.ts    # WebSocket orderbook state per market
│   ├── queues/
│   │   ├── metadata-consumer.ts    # Process metadata-fetch-queue messages
│   │   └── snapshot-consumer.ts    # Process orderbook-snapshot-queue messages
│   └── types.ts                    # Shared TypeScript interfaces
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (lightweight router)
- **Language**: TypeScript
- **Storage**: KV (cache), R2 (cold storage), Queues (async processing)
- **State**: Durable Objects (WebSocket management)

## wrangler.toml Configuration

```toml
name = "polymarket-enrichment"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Queues
[[queues.producers]]
queue = "metadata-fetch-queue"
binding = "METADATA_QUEUE"

[[queues.producers]]
queue = "orderbook-snapshot-queue"
binding = "SNAPSHOT_QUEUE"

[[queues.consumers]]
queue = "metadata-fetch-queue"
max_batch_size = 10
max_batch_timeout = 5

[[queues.consumers]]
queue = "orderbook-snapshot-queue"
max_batch_size = 50
max_batch_timeout = 10

# Durable Objects
[durable_objects]
bindings = [
  { name = "ORDERBOOK_MANAGER", class_name = "OrderbookManager" }
]

[[migrations]]
tag = "v1"
new_classes = ["OrderbookManager"]

# KV Namespace (create with: wrangler kv:namespace create MARKET_CACHE)
[[kv_namespaces]]
binding = "MARKET_CACHE"
id = "YOUR_KV_ID"

# R2 Bucket (create with: wrangler r2 bucket create polymarket-orderbooks)
[[r2_buckets]]
binding = "ORDERBOOK_STORAGE"
bucket_name = "polymarket-orderbooks"

# Environment variables
[vars]
GAMMA_API_URL = "https://gamma-api.polymarket.com"
CLOB_WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
SNAPSHOT_INTERVAL_MS = "60000"

# Secrets (set with: wrangler secret put CLICKHOUSE_URL)
# CLICKHOUSE_URL
# CLICKHOUSE_TOKEN
```

## Implementation Requirements

### 1. src/index.ts - Main Entry Point

This file must export multiple handlers for different entry points:

```typescript
import { Hono } from 'hono';
import { OrderbookManager } from './durable-objects/orderbook-manager';
import { handleMetadataQueue } from './queues/metadata-consumer';
import { handleSnapshotQueue } from './queues/snapshot-consumer';
import type { Env, GoldskyTradeEvent, MetadataFetchJob } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/webhook/goldsky', async (c) => {
  const events = await c.req.json<GoldskyTradeEvent[]>();
  
  for (const event of events) {
    // TODO: derive condition_id from token_id (your logic)
    const conditionId = event.token_id; // placeholder
    
    // Check cache, queue metadata fetch if miss
    const cached = await c.env.MARKET_CACHE.get(`market:${conditionId}`);
    if (!cached) {
      await c.env.METADATA_QUEUE.send({ 
        condition_id: conditionId, 
        token_id: event.token_id 
      } satisfies MetadataFetchJob);
    }
    
    // Trigger Durable Object to subscribe to orderbook
    const doId = c.env.ORDERBOOK_MANAGER.idFromName(conditionId);
    const stub = c.env.ORDERBOOK_MANAGER.get(doId);
    c.executionCtx.waitUntil(
      stub.fetch('http://do/subscribe', {
        method: 'POST',
        body: JSON.stringify({ condition_id: conditionId, token_ids: [event.token_id] })
      })
    );
  }
  
  return c.json({ processed: events.length });
});

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  
  // Queue consumer - routes messages to appropriate handler based on queue name
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    switch (batch.queue) {
      case 'metadata-fetch-queue':
        await handleMetadataQueue(batch as MessageBatch<MetadataFetchJob>, env);
        break;
      case 'orderbook-snapshot-queue':
        await handleSnapshotQueue(batch as MessageBatch<OrderbookSnapshot>, env);
        break;
    }
  }
};

// Export Durable Object class
export { OrderbookManager };
```

### 2. src/queues/metadata-consumer.ts

```typescript
import type { Env, MetadataFetchJob } from '../types';

export async function handleMetadataQueue(
  batch: MessageBatch<MetadataFetchJob>, 
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { condition_id, token_id } = message.body;
    
    try {
      // Fetch from Gamma API
      const res = await fetch(
        `${env.GAMMA_API_URL}/markets?condition_id=${condition_id}`
      );
      
      if (res.ok) {
        const data = await res.json();
        
        // Cache in KV (TTL: 1 hour)
        await env.MARKET_CACHE.put(
          `market:${condition_id}`, 
          JSON.stringify(data),
          { expirationTtl: 3600 }
        );
        
        // TODO: Insert into ClickHouse market_details table
      }
      
      message.ack();
    } catch (error) {
      console.error(`Failed to fetch metadata for ${condition_id}:`, error);
      message.retry();
    }
  }
}
```

### 3. src/queues/snapshot-consumer.ts

```typescript
import type { Env, OrderbookSnapshot } from '../types';

export async function handleSnapshotQueue(
  batch: MessageBatch<OrderbookSnapshot>, 
  env: Env
): Promise<void> {
  const snapshots = batch.messages.map(m => m.body);
  
  try {
    // TODO: Batch insert into ClickHouse orderbook_snapshots table
    
    // TODO: Optionally write to R2 for cold storage
    // const key = `snapshots/${date}/${condition_id}/${timestamp}.json`;
    // await env.ORDERBOOK_STORAGE.put(key, JSON.stringify(snapshots));
    
    // Ack all messages on success
    for (const message of batch.messages) {
      message.ack();
    }
  } catch (error) {
    console.error('Failed to write snapshots:', error);
    // Retry all messages on failure
    for (const message of batch.messages) {
      message.retry();
    }
  }
}
```

### 4. src/durable-objects/orderbook-manager.ts

```typescript
import type { Env, OrderbookLevel, OrderbookSnapshot } from '../types';

export class OrderbookManager implements DurableObject {
  private conditionId: string = '';
  private tokenIds: string[] = [];
  private orderbook: { bids: OrderbookLevel[]; asks: OrderbookLevel[] } = { bids: [], asks: [] };
  private ws: WebSocket | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const { condition_id, token_ids } = await request.json();
      this.conditionId = condition_id;
      this.tokenIds = token_ids;
      await this.ensureConnected();
      return new Response('subscribed');
    }
    
    if (url.pathname === '/snapshot') {
      return Response.json(this.buildSnapshot());
    }
    
    return new Response('not found', { status: 404 });
  }

  private async ensureConnected() {
    if (this.ws) return;
    
    this.ws = new WebSocket(this.env.CLOB_WSS_URL);
    
    this.ws.addEventListener('open', () => {
      this.ws!.send(JSON.stringify({
        assets_ids: this.tokenIds,
        type: 'market'
      }));
    });
    
    this.ws.addEventListener('message', (event) => {
      this.handleMessage(JSON.parse(event.data as string));
    });
    
    this.ws.addEventListener('close', () => {
      this.ws = null;
      // Schedule reconnect
      this.state.storage.setAlarm(Date.now() + 5000);
    });
    
    // Schedule first snapshot
    const interval = parseInt(this.env.SNAPSHOT_INTERVAL_MS) || 60000;
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  private handleMessage(event: any) {
    switch (event.event_type) {
      case 'book':
        this.orderbook = {
          bids: event.bids || [],
          asks: event.asks || []
        };
        break;
      case 'price_change':
        // TODO: Apply incremental updates from event.price_changes[]
        break;
    }
  }

  async alarm() {
    // Reconnect if disconnected
    if (!this.ws) {
      await this.ensureConnected();
      return;
    }
    
    // Take snapshot and queue it
    const snapshot = this.buildSnapshot();
    await this.env.SNAPSHOT_QUEUE.send(snapshot);
    
    // Schedule next snapshot
    const interval = parseInt(this.env.SNAPSHOT_INTERVAL_MS) || 60000;
    await this.state.storage.setAlarm(Date.now() + interval);
  }

  private buildSnapshot(): OrderbookSnapshot {
    const bestBid = this.orderbook.bids[0]?.price ?? null;
    const bestAsk = this.orderbook.asks[0]?.price ?? null;
    
    return {
      condition_id: this.conditionId,
      token_id: this.tokenIds[0] ?? '',
      timestamp: Date.now(),
      bids: this.orderbook.bids,
      asks: this.orderbook.asks,
      best_bid: bestBid,
      best_ask: bestAsk,
      spread: bestBid && bestAsk 
        ? parseFloat(bestAsk) - parseFloat(bestBid) 
        : null
    };
  }
}
```

### 5. src/types.ts

```typescript
export interface Env {
  MARKET_CACHE: KVNamespace;
  ORDERBOOK_STORAGE: R2Bucket;
  METADATA_QUEUE: Queue<MetadataFetchJob>;
  SNAPSHOT_QUEUE: Queue<OrderbookSnapshot>;
  ORDERBOOK_MANAGER: DurableObjectNamespace;
  GAMMA_API_URL: string;
  CLOB_WSS_URL: string;
  SNAPSHOT_INTERVAL_MS: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_TOKEN: string;
}

export interface GoldskyTradeEvent {
  tx_hash: string;
  block_number: number;
  timestamp: number;
  token_id: string;
  maker: string;
  taker: string;
  side: 'BUY' | 'SELL';
  price: string;
  amount: string;
}

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface OrderbookSnapshot {
  condition_id: string;
  token_id: string;
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  best_bid: string | null;
  best_ask: string | null;
  spread: number | null;
}

export interface MetadataFetchJob {
  condition_id: string;
  token_id: string;
}
```

## Deployment Steps

```bash
# 1. Create resources
wrangler kv:namespace create MARKET_CACHE
wrangler r2 bucket create polymarket-orderbooks
wrangler queues create metadata-fetch-queue
wrangler queues create orderbook-snapshot-queue

# 2. Update wrangler.toml with KV namespace ID

# 3. Set secrets
wrangler secret put CLICKHOUSE_URL
wrangler secret put CLICKHOUSE_TOKEN

# 4. Deploy
wrangler deploy
```

## Key Implementation Notes

- The single worker handles both HTTP requests (via `fetch`) and queue processing (via `queue` handler)
- Queue routing is done by checking `batch.queue` name in the queue handler
- Durable Object alarms are used for both periodic snapshots and WebSocket reconnection
- Use `message.ack()` on success, `message.retry()` on failure for queue messages
- The `waitUntil()` pattern keeps the request fast while DO work happens in background
- TODO placeholders are left for: condition_id derivation, ClickHouse inserts, R2 writes, price_change handling