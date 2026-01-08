import { DurableObject } from 'cloudflare:workers';
import { Env, OrderbookLevel, OrderbookSnapshot } from '../types';

export class OrderbookManager extends DurableObject<Env> {
  private conditionId?: string;
  private tokenIds: string[] = [];
  private orderbook: {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
  } = { bids: [], asks: [] };
  private ws?: WebSocket;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json() as { condition_id: string; token_id: string };
      this.conditionId = body.condition_id;

      if (!this.tokenIds.includes(body.token_id)) {
        this.tokenIds.push(body.token_id);
      }

      // Open WebSocket connection to CLOB
      await this.connectToWebSocket();

      // Schedule first alarm for snapshot
      const snapshotInterval = parseInt(this.env.SNAPSHOT_INTERVAL_MS);
      await this.ctx.storage.setAlarm(Date.now() + snapshotInterval);

      return new Response('Subscribed', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }

  private async connectToWebSocket() {
    if (this.ws || !this.conditionId) return;

    // TODO: Open WebSocket to CLOB_WSS_URL
    // TODO: Send subscription message for this.conditionId
    // TODO: Handle 'book' (full replace) and 'price_change' (incremental update) events

    // Stub implementation
    const wsUrl = `${this.env.CLOB_WSS_URL}/${this.conditionId}`;
    console.log(`TODO: Connect to WebSocket at ${wsUrl}`);

    // TODO: Use this.ctx.getWebSocketAutoResponse() for ping/pong handling
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;

    const data = JSON.parse(message);

    // TODO: Handle 'book' event - full orderbook replace
    if (data.event_type === 'book') {
      // TODO: Replace this.orderbook.bids and this.orderbook.asks
      console.log('TODO: Handle book event', data);
    }

    // TODO: Handle 'price_change' event - incremental updates
    if (data.event_type === 'price_change') {
      // TODO: Update individual price levels in orderbook
      // price_changes[] array has: { side, price, size }
      console.log('TODO: Handle price_change event', data);
    }
  }

  async alarm() {
    // Take snapshot of current orderbook
    if (!this.conditionId) return;

    for (const tokenId of this.tokenIds) {
      const snapshot: OrderbookSnapshot = {
        condition_id: this.conditionId,
        token_id: tokenId,
        timestamp: Date.now(),
        bids: this.orderbook.bids,
        asks: this.orderbook.asks,
        best_bid: this.orderbook.bids[0]?.price || null,
        best_ask: this.orderbook.asks[0]?.price || null,
        spread: this.calculateSpread()
      };

      // Queue snapshot for processing
      await this.env.SNAPSHOT_QUEUE.send(snapshot);
    }

    // Schedule next alarm
    const snapshotInterval = parseInt(this.env.SNAPSHOT_INTERVAL_MS);
    await this.ctx.storage.setAlarm(Date.now() + snapshotInterval);
  }

  private calculateSpread(): number | null {
    const bestBid = this.orderbook.bids[0];
    const bestAsk = this.orderbook.asks[0];

    if (!bestBid || !bestAsk) return null;

    return parseFloat(bestAsk.price) - parseFloat(bestBid.price);
  }
}
