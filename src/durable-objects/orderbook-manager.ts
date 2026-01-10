// src/durable-objects/orderbook-manager.ts
// Enhanced with pool management, gap detection, and proper WebSocket handling

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
  PolymarketTickSizeChangeEvent,
  PolymarketWSEvent,
  EnhancedOrderbookSnapshot,
  TradeTick,
  LocalOrderbook,
} from "../types/orderbook";

interface ConnectionState {
  ws: WebSocket | null;
  assets: Set<string>;
  pendingAssets: Set<string>; // Assets awaiting confirmation
  lastPing: number;
  subscriptionSent: boolean; // Track if we've sent subscription for current connection
}

interface PoolState {
  assetToConnection: [string, string][];
  assetToMarket: [string, string][];
  tickSizes: [string, number][];
}

/**
 * Enhanced Orderbook Manager with WebSocket Pool
 *
 * Key improvements over basic version:
 * - Handles 500 instrument limit per connection
 * - Automatic reconnection with exponential backoff
 * - Hash tracking for gap detection
 * - High-precision timestamps
 */
export class OrderbookManager extends DurableObject<Env> {
  private connections: Map<string, ConnectionState> = new Map();
  private assetToConnection: Map<string, string> = new Map();
  private assetToMarket: Map<string, string> = new Map(); // asset_id -> condition_id
  private tickSizes: Map<string, number> = new Map();

  // Local orderbook state for delta processing (Nautilus-style)
  private localBooks: Map<string, LocalOrderbook> = new Map();
  // Last quote cache for duplicate suppression
  private lastQuotes: Map<string, { bestBid: number | null; bestAsk: number | null }> = new Map();

  private readonly MAX_ASSETS_PER_CONNECTION = 450;
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private readonly PING_INTERVAL_MS = 10000; // Send PING every 10 seconds
  private readonly CONNECTION_TIMEOUT_MS = 5000; // Timeout for WebSocket connection attempts
  private readonly SNAPSHOT_INTERVAL_MS: number;
  private readonly MAX_SUBSCRIPTION_RETRIES = 3;
  private subscriptionFailures: Map<string, number> = new Map(); // Track failures per asset

  // Nautilus-style connection buffering to avoid rate limits
  private readonly INITIAL_CONNECTION_DELAY_MS = 5000; // Wait 5s before first connection (buffer subscriptions)
  private readonly RATE_LIMIT_BACKOFF_MS = 30000; // 30s backoff on 429 errors
  private rateLimitedUntil: number = 0; // Timestamp when rate limit expires
  private connectionAttempts: number = 0; // Track consecutive failures

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.SNAPSHOT_INTERVAL_MS = parseInt(env.SNAPSHOT_INTERVAL_MS) || 1000;

    // Restore state on wake
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<PoolState>("poolState");

      if (stored) {
        this.assetToConnection = new Map(stored.assetToConnection);
        this.assetToMarket = new Map(stored.assetToMarket);
        this.tickSizes = new Map(stored.tickSizes);

        // Rebuild connection asset sets
        for (const [assetId, connId] of this.assetToConnection) {
          if (!this.connections.has(connId)) {
            this.connections.set(connId, {
              ws: null,
              assets: new Set(),
              pendingAssets: new Set(),
              lastPing: 0,
              subscriptionSent: false,
            });
          }
          this.connections.get(connId)!.assets.add(assetId);
        }

        // Nautilus-style: Don't reconnect immediately on wake
        // Schedule delayed connection with jitter to avoid thundering herd
        if (this.connections.size > 0) {
          const jitter = Math.random() * 5000; // 0-5s random jitter
          const delay = this.INITIAL_CONNECTION_DELAY_MS + jitter;
          console.log(
            `[DO] Waking with ${this.connections.size} connections, ${this.assetToConnection.size} assets. ` +
            `Scheduling connection in ${Math.round(delay)}ms`
          );
          await this.ctx.storage.setAlarm(Date.now() + delay);
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/subscribe":
        return this.handleSubscribe(request);
      case "/unsubscribe":
        return this.handleUnsubscribe(request);
      case "/snapshot":
        return this.handleGetSnapshot(url);
      case "/status":
        return this.handleStatus();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      condition_id: string;
      token_ids: string[];
      tick_size?: number;
    };

    const { condition_id, token_ids, tick_size } = body;
    let subscribed = 0;

    for (const tokenId of token_ids) {
      // Skip if already subscribed
      if (this.assetToConnection.has(tokenId)) continue;

      // Skip if this asset has failed too many times
      const failures = this.subscriptionFailures.get(tokenId) || 0;
      if (failures >= this.MAX_SUBSCRIPTION_RETRIES) {
        console.warn(`[WS] Skipping asset ${tokenId} - exceeded max subscription retries`);
        continue;
      }

      // Store market mapping
      this.assetToMarket.set(tokenId, condition_id);
      if (tick_size) this.tickSizes.set(tokenId, tick_size);

      // Find or create connection with capacity
      let connId = this.findConnectionWithCapacity();
      if (!connId) {
        connId = await this.createConnection();
      }

      const conn = this.connections.get(connId)!;

      // Track subscription - mark as pending until we get book data
      this.assetToConnection.set(tokenId, connId);
      conn.assets.add(tokenId);
      conn.pendingAssets.add(tokenId);
      subscribed++;

      // If connection is open and hasn't sent subscription yet, or needs to update
      if (conn.ws?.readyState === WebSocket.OPEN) {
        // Mark that we need to send an updated subscription
        conn.subscriptionSent = false;
      }
    }

    // Send subscription messages only to connections that need updating
    await this.syncSubscriptions();
    await this.persistState();

    return Response.json({
      subscribed,
      total_assets: this.assetToConnection.size,
      connections: this.connections.size,
    });
  }

  private async handleUnsubscribe(request: Request): Promise<Response> {
    const { token_ids } = (await request.json()) as { token_ids: string[] };

    for (const tokenId of token_ids) {
      const connId = this.assetToConnection.get(tokenId);
      if (connId) {
        this.assetToConnection.delete(tokenId);
        this.assetToMarket.delete(tokenId);
        this.connections.get(connId)?.assets.delete(tokenId);
      }
    }

    await this.persistState();
    return Response.json({ unsubscribed: token_ids.length });
  }

  private handleGetSnapshot(url: URL): Response {
    const assetId = url.searchParams.get("asset_id");
    // Note: We don't store snapshots in DO memory anymore
    // They go directly to the queue
    return Response.json({
      message: "Snapshots are streamed to queue, not stored in DO",
      asset_subscribed: assetId ? this.assetToConnection.has(assetId) : false,
    });
  }

  private handleStatus(): Response {
    const connectionStats = Array.from(this.connections.entries()).map(
      ([id, state]) => ({
        id,
        connected: state.ws?.readyState === WebSocket.OPEN,
        readyState: state.ws?.readyState ?? -1,
        asset_count: state.assets.size,
        pending_count: state.pendingAssets.size,
        subscription_sent: state.subscriptionSent,
        last_ping: state.lastPing,
      })
    );

    // Get assets with failures
    const failedAssets = Array.from(this.subscriptionFailures.entries())
      .filter(([, count]) => count > 0)
      .map(([assetId, count]) => ({ assetId: assetId.slice(0, 20) + "...", failures: count }));

    return Response.json({
      total_assets: this.assetToConnection.size,
      total_pending: Array.from(this.connections.values()).reduce(
        (sum, s) => sum + s.pendingAssets.size,
        0
      ),
      connections: connectionStats,
      failed_assets: failedAssets.slice(0, 10),
      total_failed: failedAssets.length,
    });
  }

  private findConnectionWithCapacity(): string | null {
    for (const [connId, state] of this.connections) {
      if (state.assets.size < this.MAX_ASSETS_PER_CONNECTION) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          return connId;
        }
      }
    }
    return null;
  }

  private async createConnection(): Promise<string> {
    const connId = `conn_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    this.connections.set(connId, {
      ws: null,
      assets: new Set(),
      pendingAssets: new Set(),
      lastPing: 0,
      subscriptionSent: false,
    });

    await this.reconnect(connId, 0);
    return connId;
  }

  private async reconnect(connId: string, attempt: number): Promise<void> {
    const state = this.connections.get(connId);
    if (!state) return;

    // Check if we're rate limited
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const waitTime = this.rateLimitedUntil - now;
      console.log(`[WS ${connId}] Rate limited, waiting ${waitTime}ms before reconnect`);
      await this.ctx.storage.setAlarm(this.rateLimitedUntil + Math.random() * 1000);
      return;
    }

    // Close existing connection
    if (state.ws) {
      try {
        state.ws.close();
      } catch {
        // Ignore close errors
      }
      state.ws = null;
    }

    // Reset subscription state on reconnect
    state.subscriptionSent = false;
    // Move all assets back to pending on reconnect
    for (const asset of state.assets) {
      state.pendingAssets.add(asset);
    }

    // Exponential backoff with jitter (Nautilus-style)
    if (attempt > 0) {
      const baseDelay = Math.min(
        this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        this.MAX_RECONNECT_DELAY_MS
      );
      // Add 0-50% jitter to prevent thundering herd
      const jitter = baseDelay * Math.random() * 0.5;
      const delay = baseDelay + jitter;
      console.log(`[WS ${connId}] Backoff attempt ${attempt}: waiting ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      console.log(`[WS ${connId}] Attempting connection to ${this.env.CLOB_WSS_URL}`);
      const ws = new WebSocket(this.env.CLOB_WSS_URL);
      state.ws = ws;

      // Set up connection timeout
      let connectionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          console.error(`[WS ${connId}] Connection timeout after ${this.CONNECTION_TIMEOUT_MS}ms`);
          ws.close();
          state.ws = null;
          // Schedule retry with backoff
          this.ctx.storage.setAlarm(
            Date.now() + this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
          );
        }
      }, this.CONNECTION_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        // Clear timeout on successful connection
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        // Reset rate limit and failure tracking on successful connection
        this.connectionAttempts = 0;
        this.rateLimitedUntil = 0;

        console.log(`[WS ${connId}] Connected, subscribing to ${state.assets.size} assets`);
        state.lastPing = Date.now();

        // Subscribe to assets (no action field per Polymarket spec)
        if (state.assets.size > 0 && !state.subscriptionSent) {
          ws.send(
            JSON.stringify({
              assets_ids: Array.from(state.assets),
              type: "market",
            })
          );
          state.subscriptionSent = true;
          console.log(`[WS ${connId}] Subscription sent for ${state.assets.size} assets`);
        }

        // Schedule alarm for PING heartbeat
        this.ctx.storage.setAlarm(Date.now() + this.PING_INTERVAL_MS);
      });

      ws.addEventListener("message", (event) => {
        state.lastPing = Date.now();
        this.handleMessage(event.data as string, connId);
      });

      ws.addEventListener("close", (event) => {
        // Clear timeout if still pending
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        // Code 1006 = abnormal closure (connection failed)
        // Code 1000 = normal closure
        // Code 1001 = going away (server shutdown)
        const isAbnormal = event.code === 1006;
        const logLevel = isAbnormal ? "warn" : "log";
        console[logLevel](
          `[WS ${connId}] Closed: code=${event.code}, reason=${event.reason || "none"}, assets=${state.assets.size}`
        );

        state.ws = null;
        state.subscriptionSent = false;

        // If rate limited, don't schedule quick reconnect
        const now = Date.now();
        if (this.rateLimitedUntil > now) {
          console.log(`[WS ${connId}] Rate limited, will retry at ${new Date(this.rateLimitedUntil).toISOString()}`);
          return; // Alarm already scheduled by error handler
        }

        // Schedule reconnect with exponential backoff + jitter
        const baseDelay = isAbnormal
          ? this.RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(this.connectionAttempts, 5))
          : this.RECONNECT_BASE_DELAY_MS;
        const jitter = Math.random() * baseDelay * 0.5;
        const delay = Math.min(baseDelay + jitter, this.MAX_RECONNECT_DELAY_MS);

        console.log(`[WS ${connId}] Scheduling reconnect in ${Math.round(delay)}ms (attempt ${this.connectionAttempts + 1})`);
        this.ctx.storage.setAlarm(now + delay);
      });

      ws.addEventListener("error", (event) => {
        // Clear timeout on error
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        // Extract useful error info - ErrorEvent has message, Event doesn't
        const errorInfo = "message" in event
          ? (event as ErrorEvent).message
          : `WebSocket error (readyState=${ws.readyState})`;

        // Detect rate limiting (429)
        if (errorInfo.includes("429")) {
          console.error(`[WS ${connId}] RATE LIMITED (429) - backing off for ${this.RATE_LIMIT_BACKOFF_MS}ms`);
          this.rateLimitedUntil = Date.now() + this.RATE_LIMIT_BACKOFF_MS;
          this.connectionAttempts++;
          // Schedule retry after rate limit backoff
          this.ctx.storage.setAlarm(this.rateLimitedUntil);
        } else {
          console.error(`[WS ${connId}] Error: ${errorInfo}`);
          this.connectionAttempts++;
        }
      });
    } catch (error) {
      console.error(`[WS ${connId}] Connection failed:`, error);
      // Schedule retry
      this.ctx.storage.setAlarm(
        Date.now() + this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
      );
    }
  }

  private handleMessage(data: string, connId: string): void {
    const state = this.connections.get(connId);

    // Handle non-JSON protocol messages first
    if (data === "PONG") {
      // Expected heartbeat response - silently ignore
      return;
    }

    if (data === "INVALID OPERATION") {
      // Polymarket rejected the subscription - this is critical!
      console.error(
        `[WS ${connId}] INVALID OPERATION received. ` +
        `This may indicate invalid asset IDs or rate limiting.`
      );

      // Track failures for pending assets and retry with backoff
      if (state) {
        const pendingList = Array.from(state.pendingAssets);
        console.error(`[WS ${connId}] Pending assets that may be invalid: ${pendingList.slice(0, 5).join(", ")}`);

        // Increment failure count for all pending assets
        for (const assetId of state.pendingAssets) {
          const failures = (this.subscriptionFailures.get(assetId) || 0) + 1;
          this.subscriptionFailures.set(assetId, failures);

          if (failures >= this.MAX_SUBSCRIPTION_RETRIES) {
            console.error(`[WS] Asset ${assetId} exceeded max retries, removing from subscriptions`);
            this.removeAsset(assetId);
          }
        }

        // Reset subscription state to allow retry
        state.subscriptionSent = false;

        // Schedule a retry with backoff
        this.ctx.storage.setAlarm(Date.now() + this.RECONNECT_BASE_DELAY_MS * 2);
      }
      return;
    }

    // Skip non-JSON messages
    if (!data.startsWith("{") && !data.startsWith("[")) {
      console.warn(`[WS ${connId}] Unexpected non-JSON message: "${data.slice(0, 100)}"`);
      return;
    }

    const ingestionTs =
      performance.now() * 1000 + performance.timeOrigin * 1000; // Microseconds

    try {
      const event = JSON.parse(data) as PolymarketWSEvent;
      const ingestionTsFloor = Math.floor(ingestionTs);

      // Mark asset as confirmed on any valid event
      if (state && "asset_id" in event && state.pendingAssets.has(event.asset_id)) {
        state.pendingAssets.delete(event.asset_id);
        this.subscriptionFailures.delete(event.asset_id);
      }

      switch (event.event_type) {
        case "book":
          // Full orderbook snapshot - initialize/reset local book
          this.handleBookEvent(event, ingestionTsFloor);
          break;

        case "price_change":
          // Incremental update - apply deltas to local book
          this.handlePriceChangeEvent(event, ingestionTsFloor);
          break;

        case "last_trade_price":
          // Trade execution - capture for backtesting
          this.handleTradeEvent(event, ingestionTsFloor);
          break;

        case "tick_size_change":
          // Tick size update - rebuild book with new precision
          this.handleTickSizeChange(event);
          break;

        default:
          console.warn(`[WS ${connId}] Unknown event type: ${(event as { event_type: string }).event_type}`);
      }
    } catch (error) {
      console.error(`[WS ${connId}] JSON parse error for message: "${data.slice(0, 200)}"`, error);
    }
  }

  private removeAsset(assetId: string): void {
    const connId = this.assetToConnection.get(assetId);
    if (connId) {
      const state = this.connections.get(connId);
      if (state) {
        state.assets.delete(assetId);
        state.pendingAssets.delete(assetId);
      }
    }
    this.assetToConnection.delete(assetId);
    this.assetToMarket.delete(assetId);
    this.tickSizes.delete(assetId);
  }

  private async handleBookEvent(
    event: PolymarketBookEvent,
    ingestionTs: number
  ): Promise<void> {
    const sourceTs = parseInt(event.timestamp);
    const conditionId = this.assetToMarket.get(event.asset_id) || event.market;
    const tickSize = this.tickSizes.get(event.asset_id) || 0.01;

    // Parse levels
    const bids = event.bids.map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = event.asks.map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    // Initialize/reset local orderbook state (Nautilus-style L2_MBP)
    const localBook: LocalOrderbook = {
      asset_id: event.asset_id,
      condition_id: conditionId,
      bids: new Map(bids.map((b) => [b.price, b.size])),
      asks: new Map(asks.map((a) => [a.price, a.size])),
      tick_size: tickSize,
      last_hash: event.hash,
      last_update_ts: sourceTs,
      sequence: 1,
    };
    this.localBooks.set(event.asset_id, localBook);

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    // Duplicate suppression - skip if top-of-book unchanged
    const lastQuote = this.lastQuotes.get(event.asset_id);
    if (lastQuote && lastQuote.bestBid === bestBid && lastQuote.bestAsk === bestAsk) {
      return; // Skip duplicate
    }
    this.lastQuotes.set(event.asset_id, { bestBid, bestAsk });

    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

    const snapshot: EnhancedOrderbookSnapshot = {
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: conditionId,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      book_hash: event.hash,
      bids,
      asks,
      best_bid: bestBid,
      best_ask: bestAsk,
      mid_price: midPrice,
      spread,
      spread_bps: spreadBps,
      tick_size: tickSize,
      is_resync: false,
      sequence_number: localBook.sequence,
    };

    // Queue for processing
    await this.env.SNAPSHOT_QUEUE.send(snapshot);
  }

  /**
   * Handle incremental price changes (critical for real-time accuracy)
   * This is where most orderbook updates come from - NOT book events
   *
   * Note: asset_id is inside each price_change, not at the event level
   * A single event can contain changes for multiple assets
   */
  private async handlePriceChangeEvent(
    event: PolymarketPriceChangeEvent,
    ingestionTs: number
  ): Promise<void> {
    const sourceTs = parseInt(event.timestamp);

    // Group price changes by asset_id (each change has its own asset_id)
    const changesByAsset = new Map<string, typeof event.price_changes>();
    for (const change of event.price_changes) {
      const assetId = change.asset_id;
      if (!assetId) {
        console.warn(`[WS] price_change missing asset_id in change:`, JSON.stringify(change).slice(0, 100));
        continue;
      }
      if (!changesByAsset.has(assetId)) {
        changesByAsset.set(assetId, []);
      }
      changesByAsset.get(assetId)!.push(change);
    }

    // Process each asset's changes
    for (const [assetId, changes] of changesByAsset) {
      const conditionId = this.assetToMarket.get(assetId) || event.market;

      // Get local book for this asset
      const localBook = this.localBooks.get(assetId);
      if (!localBook) {
        // No initial book snapshot yet - skip until we get a book event
        // This is normal during initial subscription
        continue;
      }

      // Apply deltas to local book
      for (const change of changes) {
        const price = parseFloat(change.price);
        const size = parseFloat(change.size);
        const book = change.side === "BUY" ? localBook.bids : localBook.asks;

        if (size === 0) {
          // DELETE level
          book.delete(price);
        } else {
          // UPDATE/INSERT level
          book.set(price, size);
        }

        // Update hash if provided in the change
        if (change.hash) {
          localBook.last_hash = change.hash;
        }
      }

      localBook.sequence++;
      localBook.last_update_ts = sourceTs;

      // Extract sorted levels from local book
      const bids = Array.from(localBook.bids.entries())
        .sort((a, b) => b[0] - a[0]) // Descending for bids
        .map(([price, size]) => ({ price, size }));

      const asks = Array.from(localBook.asks.entries())
        .sort((a, b) => a[0] - b[0]) // Ascending for asks
        .map(([price, size]) => ({ price, size }));

      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;

      // Duplicate suppression - skip if top-of-book unchanged
      const lastQuote = this.lastQuotes.get(assetId);
      if (lastQuote && lastQuote.bestBid === bestBid && lastQuote.bestAsk === bestAsk) {
        continue; // Top-of-book unchanged, skip snapshot
      }
      this.lastQuotes.set(assetId, { bestBid, bestAsk });

      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
      const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

      const snapshot: EnhancedOrderbookSnapshot = {
        asset_id: assetId,
        token_id: assetId,
        condition_id: conditionId,
        source_ts: sourceTs,
        ingestion_ts: ingestionTs,
        book_hash: localBook.last_hash,
        bids,
        asks,
        best_bid: bestBid,
        best_ask: bestAsk,
        mid_price: midPrice,
        spread,
        spread_bps: spreadBps,
        tick_size: localBook.tick_size,
        is_resync: false,
        sequence_number: localBook.sequence,
      };

      await this.env.SNAPSHOT_QUEUE.send(snapshot);
    }
  }

  /**
   * Handle trade executions (critical for backtesting strategies)
   */
  private async handleTradeEvent(
    event: PolymarketLastTradePriceEvent,
    ingestionTs: number
  ): Promise<void> {
    const sourceTs = parseInt(event.timestamp);
    const conditionId = this.assetToMarket.get(event.asset_id) || event.market;

    const tradeTick: TradeTick = {
      asset_id: event.asset_id,
      condition_id: conditionId,
      trade_id: `${event.asset_id}-${sourceTs}-${crypto.randomUUID().slice(0, 8)}`,
      price: parseFloat(event.price),
      size: parseFloat(event.size),
      side: event.side,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
    };

    // Queue trade tick for ClickHouse insertion
    await this.env.TRADE_QUEUE.send(tradeTick);
  }

  /**
   * Handle tick size changes - rebuild book with new precision
   */
  private handleTickSizeChange(event: PolymarketTickSizeChangeEvent): void {
    const newTickSize = parseFloat(event.new_tick_size);
    const oldTickSize = parseFloat(event.old_tick_size);

    console.log(
      `[WS] Tick size change for ${event.asset_id}: ${oldTickSize} -> ${newTickSize}`
    );

    // Update stored tick size
    this.tickSizes.set(event.asset_id, newTickSize);

    // Clear local book to force resync with new precision
    const localBook = this.localBooks.get(event.asset_id);
    if (localBook) {
      localBook.tick_size = newTickSize;
      // Book will be rebuilt on next 'book' event
    }
  }

  private async syncSubscriptions(): Promise<void> {
    for (const [connId, state] of this.connections) {
      // Only send if connection is open, has assets, and hasn't sent yet (or needs update)
      if (
        state.ws?.readyState === WebSocket.OPEN &&
        state.assets.size > 0 &&
        !state.subscriptionSent
      ) {
        try {
          state.ws.send(
            JSON.stringify({
              assets_ids: Array.from(state.assets),
              type: "market",
            })
          );
          state.subscriptionSent = true;
          console.log(`[WS ${connId}] Subscription synced for ${state.assets.size} assets`);
        } catch (error) {
          console.error(`[WS ${connId}] Failed to send subscription:`, error);
          state.subscriptionSent = false;
        }
      }
    }
  }

  async alarm(): Promise<void> {
    const startTime = Date.now();
    let hasActiveConnections = false;
    let reconnectCount = 0;
    let pingCount = 0;

    // Check if we're still rate limited
    if (this.rateLimitedUntil > startTime) {
      const waitTime = this.rateLimitedUntil - startTime;
      console.log(`[Alarm] Rate limited, rescheduling in ${waitTime}ms`);
      await this.ctx.storage.setAlarm(this.rateLimitedUntil + Math.random() * 1000);
      return;
    }

    console.log(`[Alarm] Starting - ${this.connections.size} connections, ${this.assetToConnection.size} assets`);

    for (const [connId, state] of this.connections) {
      const readyState = state.ws?.readyState ?? -1;

      if (!state.ws || readyState !== WebSocket.OPEN) {
        // Reconnect disconnected connections - but stagger them
        console.log(`[Alarm] Connection ${connId} not open (readyState=${readyState}), reconnecting`);
        reconnectCount++;

        // Stagger reconnects to avoid thundering herd
        if (reconnectCount > 1) {
          // Wait 100-500ms between connection attempts
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
        }

        // Don't await reconnect - let it happen async to avoid blocking alarm
        this.reconnect(connId, this.connectionAttempts);
      } else {
        // Send ping to keep connection alive (lowercase per Polymarket protocol)
        try {
          state.ws.send("ping");
          hasActiveConnections = true;
          pingCount++;

          // If subscription wasn't sent yet (e.g., after INVALID OPERATION), try again
          if (!state.subscriptionSent && state.assets.size > 0) {
            console.log(`[WS ${connId}] Retrying subscription for ${state.assets.size} assets`);
            state.ws.send(
              JSON.stringify({
                assets_ids: Array.from(state.assets),
                type: "market",
              })
            );
            state.subscriptionSent = true;
          }
        } catch (error) {
          console.error(`[WS ${connId}] Failed to send PING:`, error);
          state.ws = null;
          this.reconnect(connId, this.connectionAttempts);
          reconnectCount++;
        }
      }
    }

    // Schedule next alarm if we have active connections
    if (hasActiveConnections || this.connections.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.PING_INTERVAL_MS);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Alarm] Completed in ${elapsed}ms - pings=${pingCount}, reconnects=${reconnectCount}`);
  }

  private async persistState(): Promise<void> {
    await this.ctx.storage.put("poolState", {
      assetToConnection: Array.from(this.assetToConnection.entries()),
      assetToMarket: Array.from(this.assetToMarket.entries()),
      tickSizes: Array.from(this.tickSizes.entries()),
    } satisfies PoolState);
  }
}
