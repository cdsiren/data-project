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
  BBOSnapshot,
  TradeTick,
  LocalOrderbook,
  OrderbookLevelChange,
  FullL2Snapshot,
  LevelChangeType,
  Trigger,
  TriggerEvent,
  TriggerRegistration,
  PriceHistoryEntry,
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
  negRisk: [string, boolean][];
  orderMinSizes: [string, number][];
  triggers?: Trigger[]; // Low-latency triggers
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
  private negRisk: Map<string, boolean> = new Map(); // asset_id -> neg_risk flag
  private orderMinSizes: Map<string, number> = new Map(); // asset_id -> order_min_size

  // Local orderbook state for delta processing (Nautilus-style)
  private localBooks: Map<string, LocalOrderbook> = new Map();
  // Last quote cache for duplicate suppression
  private lastQuotes: Map<string, { bestBid: number | null; bestAsk: number | null }> = new Map();
  // Track last full L2 snapshot time per asset (for 5-minute periodic snapshots)
  private lastFullL2SnapshotTs: Map<string, number> = new Map();

  // ============================================================
  // LOW-LATENCY TRIGGER SYSTEM
  // Processes signals directly, bypassing queues for <50ms latency
  // ============================================================
  private triggers: Map<string, Trigger> = new Map(); // trigger_id -> Trigger
  private triggersByAsset: Map<string, Set<string>> = new Map(); // asset_id -> Set<trigger_id>
  private lastTriggerFire: Map<string, number> = new Map(); // trigger_id -> last fire timestamp
  private priceHistory: Map<string, PriceHistoryEntry[]> = new Map(); // asset_id -> price history for PRICE_MOVE
  // Latest BBO per asset for arbitrage trigger evaluation
  private latestBBO: Map<string, { best_bid: number | null; best_ask: number | null; ts: number }> = new Map();
  private readonly PRICE_HISTORY_MAX_AGE_MS = 60000; // Keep 60s of price history
  private readonly MAX_TRIGGERS_PER_ASSET = 50; // Prevent trigger spam

  private readonly MAX_ASSETS_PER_CONNECTION = 450;
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private readonly PING_INTERVAL_MS = 10000; // Send PING every 10 seconds
  private readonly CONNECTION_TIMEOUT_MS = 5000; // Timeout for WebSocket connection attempts
  private readonly SNAPSHOT_INTERVAL_MS: number;
  private readonly FULL_L2_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes for full L2 snapshots
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
        this.negRisk = new Map(stored.negRisk || []);
        this.orderMinSizes = new Map(stored.orderMinSizes || []);

        // Restore triggers
        if (stored.triggers) {
          for (const trigger of stored.triggers) {
            this.triggers.set(trigger.id, trigger);
            if (!this.triggersByAsset.has(trigger.asset_id)) {
              this.triggersByAsset.set(trigger.asset_id, new Set());
            }
            this.triggersByAsset.get(trigger.asset_id)!.add(trigger.id);
          }
          console.log(`[DO] Restored ${this.triggers.size} triggers`);
        }

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
      // Trigger management endpoints
      case "/triggers":
        if (request.method === "GET") {
          return this.handleListTriggers();
        } else if (request.method === "POST") {
          return this.handleRegisterTrigger(request);
        }
        return new Response("method not allowed", { status: 405 });
      case "/triggers/delete":
        return this.handleDeleteTrigger(request);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      condition_id: string;
      token_ids: string[];
      tick_size?: number;
      neg_risk?: boolean;
      order_min_size?: number;
    };

    const { condition_id, token_ids, tick_size, neg_risk, order_min_size } = body;
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

      // Store market mapping and metadata
      this.assetToMarket.set(tokenId, condition_id);
      if (tick_size) this.tickSizes.set(tokenId, tick_size);
      if (neg_risk !== undefined) this.negRisk.set(tokenId, neg_risk);
      if (order_min_size !== undefined) this.orderMinSizes.set(tokenId, order_min_size);

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
        this.connections.get(connId)?.pendingAssets.delete(tokenId);
      }

      // Clean up all in-memory state to prevent memory leaks
      this.tickSizes.delete(tokenId);
      this.negRisk.delete(tokenId);
      this.orderMinSizes.delete(tokenId);
      this.localBooks.delete(tokenId);
      this.lastQuotes.delete(tokenId);
      this.lastFullL2SnapshotTs.delete(tokenId);
      this.subscriptionFailures.delete(tokenId);
      this.priceHistory.delete(tokenId);

      // Clean up triggers for this asset
      const triggerIds = this.triggersByAsset.get(tokenId);
      if (triggerIds) {
        for (const triggerId of triggerIds) {
          this.triggers.delete(triggerId);
          this.lastTriggerFire.delete(triggerId);
        }
        this.triggersByAsset.delete(tokenId);
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

    // Early return if connection state is missing (could happen during cleanup)
    if (!state) {
      console.warn(`[WS ${connId}] Received message for unknown connection, ignoring`);
      return;
    }

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

    // Clean up all maps to prevent memory leaks
    this.assetToConnection.delete(assetId);
    this.assetToMarket.delete(assetId);
    this.tickSizes.delete(assetId);
    this.negRisk.delete(assetId);
    this.orderMinSizes.delete(assetId);
    this.localBooks.delete(assetId);
    this.lastQuotes.delete(assetId);
    this.lastFullL2SnapshotTs.delete(assetId);
    this.subscriptionFailures.delete(assetId);
    this.priceHistory.delete(assetId);

    // Clean up triggers for this asset
    const triggerIds = this.triggersByAsset.get(assetId);
    if (triggerIds) {
      for (const triggerId of triggerIds) {
        this.triggers.delete(triggerId);
        this.lastTriggerFire.delete(triggerId);
      }
      this.triggersByAsset.delete(assetId);
    }
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

    // Emit full L2 snapshot on book event (initial snapshot or resync)
    const fullL2Snapshot: FullL2Snapshot = {
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: conditionId,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      book_hash: event.hash,
      bids,
      asks,
      tick_size: tickSize,
      sequence_number: localBook.sequence,
      neg_risk: this.negRisk.get(event.asset_id),
      order_min_size: this.orderMinSizes.get(event.asset_id),
    };
    await this.env.FULL_L2_QUEUE.send(fullL2Snapshot);
    this.lastFullL2SnapshotTs.set(event.asset_id, sourceTs);

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const bidSize = bids[0]?.size ?? null;
    const askSize = asks[0]?.size ?? null;

    // Duplicate suppression - skip if top-of-book unchanged
    const lastQuote = this.lastQuotes.get(event.asset_id);
    if (lastQuote && lastQuote.bestBid === bestBid && lastQuote.bestAsk === bestAsk) {
      return; // Skip duplicate
    }
    this.lastQuotes.set(event.asset_id, { bestBid, bestAsk });

    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

    // BBO-only snapshot (~20-50x smaller than full L2)
    const snapshot: BBOSnapshot = {
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: conditionId,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      book_hash: event.hash,
      best_bid: bestBid,
      best_ask: bestAsk,
      bid_size: bidSize,
      ask_size: askSize,
      mid_price: midPrice,
      spread_bps: spreadBps,
      tick_size: tickSize,
      is_resync: false,
      sequence_number: localBook.sequence,
      neg_risk: this.negRisk.get(event.asset_id),
      order_min_size: this.orderMinSizes.get(event.asset_id),
    };

    // Queue for processing (async, goes through batching)
    await this.env.SNAPSHOT_QUEUE.send(snapshot);

    // LOW-LATENCY: Evaluate triggers immediately (bypasses queues)
    await this.evaluateTriggers(snapshot);
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

      // Collect level changes for this batch
      const levelChanges: OrderbookLevelChange[] = [];

      // Apply deltas to local book and track level changes
      for (const change of changes) {
        const price = parseFloat(change.price);
        const newSize = parseFloat(change.size);
        const book = change.side === "BUY" ? localBook.bids : localBook.asks;
        const oldSize = book.get(price) ?? 0;

        // Determine change type
        let changeType: LevelChangeType;
        if (oldSize === 0 && newSize > 0) {
          changeType = "ADD";
        } else if (newSize === 0 && oldSize > 0) {
          changeType = "REMOVE";
        } else {
          changeType = "UPDATE";
        }

        // Emit level change event
        levelChanges.push({
          asset_id: assetId,
          condition_id: conditionId,
          source_ts: sourceTs,
          ingestion_ts: ingestionTs,
          side: change.side as "BUY" | "SELL",
          price,
          old_size: oldSize,
          new_size: newSize,
          size_delta: newSize - oldSize,
          change_type: changeType,
          book_hash: change.hash || localBook.last_hash,
          sequence_number: localBook.sequence + 1,
        });

        // Apply change to local book
        if (newSize === 0) {
          book.delete(price);
        } else {
          book.set(price, newSize);
        }

        // Update hash if provided in the change
        if (change.hash) {
          localBook.last_hash = change.hash;
        }
      }

      localBook.sequence++;
      localBook.last_update_ts = sourceTs;

      // Send level changes to queue (batch for efficiency)
      if (levelChanges.length > 0) {
        await this.env.LEVEL_CHANGE_QUEUE.sendBatch(
          levelChanges.map((lc) => ({ body: lc }))
        );
      }

      // Check if it's time for a periodic full L2 snapshot (every 5 minutes)
      const lastFullL2Ts = this.lastFullL2SnapshotTs.get(assetId) || 0;
      if (sourceTs - lastFullL2Ts >= this.FULL_L2_INTERVAL_MS) {
        // Extract full L2 depth for snapshot
        const sortedBids = Array.from(localBook.bids.entries())
          .sort((a, b) => b[0] - a[0])
          .map(([price, size]) => ({ price, size }));
        const sortedAsks = Array.from(localBook.asks.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([price, size]) => ({ price, size }));

        const fullL2Snapshot: FullL2Snapshot = {
          asset_id: assetId,
          token_id: assetId,
          condition_id: conditionId,
          source_ts: sourceTs,
          ingestion_ts: ingestionTs,
          book_hash: localBook.last_hash,
          bids: sortedBids,
          asks: sortedAsks,
          tick_size: localBook.tick_size,
          sequence_number: localBook.sequence,
          neg_risk: this.negRisk.get(assetId),
          order_min_size: this.orderMinSizes.get(assetId),
        };

        await this.env.FULL_L2_QUEUE.send(fullL2Snapshot);
        this.lastFullL2SnapshotTs.set(assetId, sourceTs);
      }

      // Extract sorted levels from local book (only need top-of-book for BBO)
      const sortedBids = Array.from(localBook.bids.entries())
        .sort((a, b) => b[0] - a[0]); // Descending for bids
      const sortedAsks = Array.from(localBook.asks.entries())
        .sort((a, b) => a[0] - b[0]); // Ascending for asks

      const bestBid = sortedBids[0]?.[0] ?? null;
      const bestAsk = sortedAsks[0]?.[0] ?? null;
      const bidSize = sortedBids[0]?.[1] ?? null;
      const askSize = sortedAsks[0]?.[1] ?? null;

      // Duplicate suppression - skip if top-of-book unchanged
      const lastQuote = this.lastQuotes.get(assetId);
      if (lastQuote && lastQuote.bestBid === bestBid && lastQuote.bestAsk === bestAsk) {
        continue; // Top-of-book unchanged, skip snapshot
      }
      this.lastQuotes.set(assetId, { bestBid, bestAsk });

      const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
      const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
      const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

      // BBO-only snapshot (~20-50x smaller than full L2)
      const snapshot: BBOSnapshot = {
        asset_id: assetId,
        token_id: assetId,
        condition_id: conditionId,
        source_ts: sourceTs,
        ingestion_ts: ingestionTs,
        book_hash: localBook.last_hash,
        best_bid: bestBid,
        best_ask: bestAsk,
        bid_size: bidSize,
        ask_size: askSize,
        mid_price: midPrice,
        spread_bps: spreadBps,
        tick_size: localBook.tick_size,
        is_resync: false,
        sequence_number: localBook.sequence,
        neg_risk: this.negRisk.get(assetId),
        order_min_size: this.orderMinSizes.get(assetId),
      };

      // Queue for processing (async, goes through batching)
      await this.env.SNAPSHOT_QUEUE.send(snapshot);

      // LOW-LATENCY: Evaluate triggers immediately (bypasses queues)
      await this.evaluateTriggers(snapshot);
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

        // Await reconnect to ensure orderly connection management and prevent race conditions
        await this.reconnect(connId, this.connectionAttempts);
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
      negRisk: Array.from(this.negRisk.entries()),
      orderMinSizes: Array.from(this.orderMinSizes.entries()),
      triggers: Array.from(this.triggers.values()),
    } satisfies PoolState);
  }

  // ============================================================
  // TRIGGER MANAGEMENT ENDPOINTS
  // ============================================================

  private handleListTriggers(): Response {
    const triggers = Array.from(this.triggers.values());
    return Response.json({
      triggers,
      total: triggers.length,
      by_asset: Object.fromEntries(
        Array.from(this.triggersByAsset.entries()).map(([k, v]) => [k, v.size])
      ),
    });
  }

  private async handleRegisterTrigger(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as Partial<Trigger>;

      // Validate required fields
      if (!body.asset_id || !body.condition || !body.webhook_url) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: "Missing required fields: asset_id, condition, webhook_url",
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      // Check trigger limit per asset
      const existingCount = this.triggersByAsset.get(body.asset_id)?.size || 0;
      if (existingCount >= this.MAX_TRIGGERS_PER_ASSET) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: `Max ${this.MAX_TRIGGERS_PER_ASSET} triggers per asset`,
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      const trigger: Trigger = {
        id: body.id || `trig_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
        asset_id: body.asset_id,
        condition: body.condition,
        webhook_url: body.webhook_url,
        webhook_secret: body.webhook_secret,
        enabled: body.enabled ?? true,
        cooldown_ms: body.cooldown_ms ?? 1000,
        created_at: Date.now(),
        metadata: body.metadata,
      };

      // Store trigger
      this.triggers.set(trigger.id, trigger);
      if (!this.triggersByAsset.has(trigger.asset_id)) {
        this.triggersByAsset.set(trigger.asset_id, new Set());
      }
      this.triggersByAsset.get(trigger.asset_id)!.add(trigger.id);

      // Also index wildcard triggers
      if (trigger.asset_id === "*") {
        for (const assetId of this.assetToConnection.keys()) {
          if (!this.triggersByAsset.has(assetId)) {
            this.triggersByAsset.set(assetId, new Set());
          }
          this.triggersByAsset.get(assetId)!.add(trigger.id);
        }
      }

      await this.persistState();

      console.log(
        `[Trigger] Registered trigger ${trigger.id} for ${trigger.asset_id}: ${trigger.condition.type}`
      );

      return Response.json({
        trigger_id: trigger.id,
        status: "created",
      } as TriggerRegistration);
    } catch (error) {
      return Response.json(
        { trigger_id: "", status: "error", message: String(error) } as TriggerRegistration,
        { status: 500 }
      );
    }
  }

  private async handleDeleteTrigger(request: Request): Promise<Response> {
    try {
      const { trigger_id } = (await request.json()) as { trigger_id: string };

      const trigger = this.triggers.get(trigger_id);
      if (!trigger) {
        return Response.json({ status: "error", message: "Trigger not found" }, { status: 404 });
      }

      // Remove from both maps
      this.triggers.delete(trigger_id);
      this.triggersByAsset.get(trigger.asset_id)?.delete(trigger_id);

      // If wildcard, remove from all assets
      if (trigger.asset_id === "*") {
        for (const assetTriggers of this.triggersByAsset.values()) {
          assetTriggers.delete(trigger_id);
        }
      }

      await this.persistState();

      console.log(`[Trigger] Deleted trigger ${trigger_id}`);
      return Response.json({ status: "deleted", trigger_id });
    } catch (error) {
      return Response.json({ status: "error", message: String(error) }, { status: 500 });
    }
  }

  // ============================================================
  // TRIGGER EVALUATION - Called on every BBO update
  // ============================================================

  private async evaluateTriggers(snapshot: BBOSnapshot): Promise<void> {
    // Store latest BBO for arbitrage calculations
    this.latestBBO.set(snapshot.asset_id, {
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      ts: snapshot.source_ts,
    });

    const assetTriggerIds = this.triggersByAsset.get(snapshot.asset_id);
    const wildcardTriggerIds = this.triggersByAsset.get("*");

    const triggerIdsToCheck = new Set<string>();
    if (assetTriggerIds) {
      for (const id of assetTriggerIds) triggerIdsToCheck.add(id);
    }
    if (wildcardTriggerIds) {
      for (const id of wildcardTriggerIds) triggerIdsToCheck.add(id);
    }

    if (triggerIdsToCheck.size === 0) return;

    const now = performance.now() * 1000 + performance.timeOrigin * 1000; // Microseconds

    // Update price history for PRICE_MOVE triggers
    if (snapshot.mid_price !== null) {
      let history = this.priceHistory.get(snapshot.asset_id);
      if (!history) {
        history = [];
        this.priceHistory.set(snapshot.asset_id, history);
      }
      history.push({ ts: snapshot.source_ts, mid_price: snapshot.mid_price });

      // Prune old entries
      const cutoff = snapshot.source_ts - this.PRICE_HISTORY_MAX_AGE_MS;
      while (history.length > 0 && history[0].ts < cutoff) {
        history.shift();
      }
    }

    for (const triggerId of triggerIdsToCheck) {
      const trigger = this.triggers.get(triggerId);
      if (!trigger || !trigger.enabled) continue;

      // Check cooldown
      const lastFire = this.lastTriggerFire.get(triggerId) || 0;
      if (now - lastFire < trigger.cooldown_ms * 1000) continue; // Convert ms to us

      const result = this.checkTriggerCondition(trigger, snapshot);
      if (result.fired) {
        this.lastTriggerFire.set(triggerId, now);

        const event: TriggerEvent = {
          trigger_id: triggerId,
          trigger_type: trigger.condition.type,
          asset_id: snapshot.asset_id,
          condition_id: snapshot.condition_id,
          fired_at: Math.floor(now),
          latency_us: Math.floor(now - snapshot.source_ts * 1000), // source_ts is ms, convert to us

          best_bid: snapshot.best_bid,
          best_ask: snapshot.best_ask,
          bid_size: snapshot.bid_size,
          ask_size: snapshot.ask_size,
          mid_price: snapshot.mid_price,
          spread_bps: snapshot.spread_bps,

          threshold: trigger.condition.threshold,
          actual_value: result.actualValue,

          // Add arbitrage-specific fields if applicable
          ...result.arbitrageData,

          book_hash: snapshot.book_hash,
          sequence_number: snapshot.sequence_number,
          metadata: trigger.metadata,
        };

        // Fire webhook asynchronously (don't block event processing)
        this.dispatchTriggerWebhook(trigger, event).catch((err) =>
          console.error(`[Trigger] Webhook dispatch failed for ${triggerId}:`, err)
        );
      }
    }
  }

  private checkTriggerCondition(
    trigger: Trigger,
    snapshot: BBOSnapshot
  ): { fired: boolean; actualValue: number; arbitrageData?: Partial<TriggerEvent> } {
    const { type, threshold, side, window_ms, counterpart_asset_id } = trigger.condition;

    switch (type) {
      case "PRICE_ABOVE": {
        const price = side === "ASK" ? snapshot.best_ask : snapshot.best_bid;
        if (price !== null && price > threshold) {
          return { fired: true, actualValue: price };
        }
        break;
      }

      case "PRICE_BELOW": {
        const price = side === "ASK" ? snapshot.best_ask : snapshot.best_bid;
        if (price !== null && price < threshold) {
          return { fired: true, actualValue: price };
        }
        break;
      }

      case "SPREAD_NARROW": {
        if (snapshot.spread_bps !== null && snapshot.spread_bps < threshold) {
          return { fired: true, actualValue: snapshot.spread_bps };
        }
        break;
      }

      case "SPREAD_WIDE": {
        if (snapshot.spread_bps !== null && snapshot.spread_bps > threshold) {
          return { fired: true, actualValue: snapshot.spread_bps };
        }
        break;
      }

      case "IMBALANCE_BID": {
        // Imbalance = (bid_size - ask_size) / (bid_size + ask_size)
        if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
          const total = snapshot.bid_size + snapshot.ask_size;
          if (total > 0) {
            const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
            if (imbalance > threshold) {
              return { fired: true, actualValue: imbalance };
            }
          }
        }
        break;
      }

      case "IMBALANCE_ASK": {
        if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
          const total = snapshot.bid_size + snapshot.ask_size;
          if (total > 0) {
            const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
            if (imbalance < -threshold) {
              return { fired: true, actualValue: imbalance };
            }
          }
        }
        break;
      }

      case "SIZE_SPIKE": {
        const size = side === "ASK" ? snapshot.ask_size : snapshot.bid_size;
        if (size !== null && size > threshold) {
          return { fired: true, actualValue: size };
        }
        break;
      }

      case "PRICE_MOVE": {
        // Check if price moved threshold% within window_ms
        if (snapshot.mid_price === null || !window_ms) break;

        const history = this.priceHistory.get(snapshot.asset_id);
        if (!history || history.length === 0) break;

        const windowStart = snapshot.source_ts - window_ms;
        const oldEntry = history.find((h) => h.ts >= windowStart);
        if (oldEntry && oldEntry.mid_price > 0) {
          const pctChange =
            Math.abs((snapshot.mid_price - oldEntry.mid_price) / oldEntry.mid_price) * 100;
          if (pctChange >= threshold) {
            return { fired: true, actualValue: pctChange };
          }
        }
        break;
      }

      case "CROSSED_BOOK": {
        // Bid >= Ask indicates crossed book (rare, potential arb)
        if (
          snapshot.best_bid !== null &&
          snapshot.best_ask !== null &&
          snapshot.best_bid >= snapshot.best_ask
        ) {
          return { fired: true, actualValue: snapshot.best_bid - snapshot.best_ask };
        }
        break;
      }

      case "ARBITRAGE_BUY": {
        // YES_ask + NO_ask < threshold means buying both guarantees profit
        // threshold is typically < 1.0 (e.g., 0.99 to account for fees)
        if (!counterpart_asset_id || snapshot.best_ask === null) break;

        const counterpartBBO = this.latestBBO.get(counterpart_asset_id);
        if (!counterpartBBO || counterpartBBO.best_ask === null) break;

        // Check if data is stale (more than 5 seconds old)
        if (Math.abs(snapshot.source_ts - counterpartBBO.ts) > 5000) break;

        const sumOfAsks = snapshot.best_ask + counterpartBBO.best_ask;
        if (sumOfAsks < threshold) {
          // Profit = 1 - sumOfAsks (guaranteed payout is $1)
          const profitBps = (1 - sumOfAsks) * 10000;
          return {
            fired: true,
            actualValue: sumOfAsks,
            arbitrageData: {
              counterpart_asset_id,
              counterpart_best_bid: counterpartBBO.best_bid,
              counterpart_best_ask: counterpartBBO.best_ask,
              sum_of_asks: sumOfAsks,
              potential_profit_bps: profitBps,
            },
          };
        }
        break;
      }

      case "ARBITRAGE_SELL": {
        // YES_bid + NO_bid > threshold means selling both guarantees profit
        // threshold is typically > 1.0 (e.g., 1.01 to account for fees)
        if (!counterpart_asset_id || snapshot.best_bid === null) break;

        const counterpartBBO = this.latestBBO.get(counterpart_asset_id);
        if (!counterpartBBO || counterpartBBO.best_bid === null) break;

        // Check if data is stale (more than 5 seconds old)
        if (Math.abs(snapshot.source_ts - counterpartBBO.ts) > 5000) break;

        const sumOfBids = snapshot.best_bid + counterpartBBO.best_bid;
        if (sumOfBids > threshold) {
          // Profit = sumOfBids - 1 (you receive more than the $1 you'll pay out)
          const profitBps = (sumOfBids - 1) * 10000;
          return {
            fired: true,
            actualValue: sumOfBids,
            arbitrageData: {
              counterpart_asset_id,
              counterpart_best_bid: counterpartBBO.best_bid,
              counterpart_best_ask: counterpartBBO.best_ask,
              sum_of_bids: sumOfBids,
              potential_profit_bps: profitBps,
            },
          };
        }
        break;
      }
    }

    return { fired: false, actualValue: 0 };
  }

  private async dispatchTriggerWebhook(trigger: Trigger, event: TriggerEvent): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Trigger-ID": trigger.id,
      "X-Trigger-Type": trigger.condition.type,
    };

    // Add HMAC signature if secret is configured
    if (trigger.webhook_secret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(trigger.webhook_secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
      headers["X-Trigger-Signature"] = btoa(String.fromCharCode(...new Uint8Array(signature)));
    }

    const response = await fetch(trigger.webhook_url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      console.error(
        `[Trigger] Webhook failed for ${trigger.id}: ${response.status} ${await response.text()}`
      );
    } else {
      console.log(
        `[Trigger] Fired ${trigger.id} (${trigger.condition.type}) for ${event.asset_id} ` +
          `@ ${event.actual_value.toFixed(4)}, latency=${Math.round(event.latency_us / 1000)}ms`
      );
    }
  }
}
