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
  private readonly MAX_PRICE_HISTORY_ENTRIES = 1000; // Safety limit to prevent unbounded growth
  private readonly MAX_TRIGGERS_PER_ASSET = 50; // Prevent trigger spam

  // Polymarket allows max 500 instruments per connection
  // We use 450 to leave headroom for pending subscriptions during updates
  private readonly POLYMARKET_MAX_INSTRUMENTS = 500;
  private readonly MAX_ASSETS_PER_CONNECTION = this.POLYMARKET_MAX_INSTRUMENTS - 50;
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private readonly PING_INTERVAL_MS = 10000; // Send PING every 10 seconds
  private readonly CONNECTION_TIMEOUT_MS = 15000; // Timeout for WebSocket connection attempts (increased from 5s)
  private readonly SNAPSHOT_INTERVAL_MS: number;
  private readonly FULL_L2_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes for full L2 snapshots
  private readonly MAX_SUBSCRIPTION_RETRIES = 3;
  private subscriptionFailures: Map<string, number> = new Map(); // Track failures per asset

  // Nautilus-style connection buffering to avoid rate limits
  private initialConnectionDelayMs: number = 5000; // Base delay, will be adjusted with DO ID stagger
  private readonly RATE_LIMIT_BASE_BACKOFF_MS = 60000; // Start at 60s backoff on 429 errors (increased from 30s)
  private readonly RATE_LIMIT_MAX_BACKOFF_MS = 300000; // Cap at 5 minutes
  private rateLimitedUntil: number = 0; // Timestamp when rate limit expires
  private rateLimitCount: number = 0; // Track consecutive rate limits for exponential backoff
  private connectionAttempts: number = 0; // Track consecutive failures
  private nextAlarmTime: number | null = null; // Track scheduled alarm to prevent duplicates

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.SNAPSHOT_INTERVAL_MS = parseInt(env.SNAPSHOT_INTERVAL_MS) || 1000;

    // Stagger initial connection delay based on DO ID to prevent thundering herd
    // Each DO gets a unique 0-60 second offset based on its ID hash
    // Use a better hash function for more uniform distribution
    const doIdStr = this.ctx.id.toString();
    const doIdHash = Array.from(doIdStr).reduce((acc, char, idx) => {
      return ((acc << 5) - acc) + char.charCodeAt(0) + idx;
    }, 0);
    const staggerMs = (Math.abs(doIdHash) % 60) * 1000; // 0-60 second stagger
    this.initialConnectionDelayMs = 5000 + staggerMs;

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
          const jitter = Math.random() * 10000; // 0-10s random jitter (increased from 5s)
          const delay = this.initialConnectionDelayMs + jitter;
          console.log(
            `[DO] Waking with ${this.connections.size} connections, ${this.assetToConnection.size} assets. ` +
            `Scheduling connection in ${Math.round(delay)}ms (stagger=${Math.round(this.initialConnectionDelayMs - 5000)}ms)`
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

      // Use consolidated cleanup method
      this.cleanupAssetState(tokenId);
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

    // Get assets with failures (only truncate long IDs)
    const failedAssets = Array.from(this.subscriptionFailures.entries())
      .filter(([, count]) => count > 0)
      .map(([assetId, count]) => ({
        assetId: assetId.length > 23 ? assetId.slice(0, 20) + "..." : assetId,
        failures: count,
      }));

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
      // Add extra jitter (0-10s) when rescheduling to spread out reconnection attempts
      const extraJitter = Math.random() * 10000;
      console.log(`[WS ${connId}] Rate limited, will retry at ${new Date(this.rateLimitedUntil + extraJitter).toISOString()}`);
      await this.ctx.storage.setAlarm(this.rateLimitedUntil + extraJitter);
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

      // Set up connection timeout with race condition protection
      let connectionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        // Check both readyState and that we're still referencing this WS instance
        if (ws.readyState === WebSocket.CONNECTING && state.ws === ws) {
          console.error(`[WS ${connId}] Connection timeout after ${this.CONNECTION_TIMEOUT_MS}ms`);
          ws.close();
          state.ws = null;
          // Schedule retry with backoff
          this.scheduleAlarm(this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
        }
        connectionTimeout = null;
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
        this.rateLimitCount = 0; // Reset exponential backoff on success

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
        this.scheduleAlarm(this.PING_INTERVAL_MS);
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
        this.scheduleAlarm(delay);
      });

      ws.addEventListener("error", (event) => {
        // Clear timeout on error
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        // Extract useful error info using type guard
        const errorInfo = this.isErrorEvent(event)
          ? event.message
          : `WebSocket error (readyState=${ws.readyState})`;

        // Detect rate limiting (429)
        if (errorInfo.includes("429")) {
          this.rateLimitCount++;
          this.connectionAttempts++;

          // Exponential backoff: 60s, 120s, 240s, 300s (capped at 5 min)
          const baseBackoff = Math.min(
            this.RATE_LIMIT_BASE_BACKOFF_MS * Math.pow(2, this.rateLimitCount - 1),
            this.RATE_LIMIT_MAX_BACKOFF_MS
          );
          // Add significant jitter (0-50% of backoff) to prevent thundering herd
          const jitter = Math.random() * baseBackoff * 0.5;
          const totalBackoff = baseBackoff + jitter;

          this.rateLimitedUntil = Date.now() + totalBackoff;
          console.error(
            `[WS ${connId}] RATE LIMITED (429) - exponential backoff ${Math.round(totalBackoff / 1000)}s ` +
            `(attempt ${this.rateLimitCount}, base=${baseBackoff / 1000}s, jitter=${Math.round(jitter / 1000)}s)`
          );
          // Schedule retry after rate limit backoff
          this.scheduleAlarm(totalBackoff);
        } else {
          console.error(`[WS ${connId}] Error: ${errorInfo}`);
          this.connectionAttempts++;
        }
      });
    } catch (error) {
      console.error(`[WS ${connId}] Connection failed:`, error);
      // Schedule retry
      this.scheduleAlarm(this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
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
      console.warn(`[WS ${connId}] Unexpected non-JSON message: "${data.length > 100 ? data.slice(0, 100) + "..." : data}"`);
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
      console.error(`[WS ${connId}] JSON parse error for message: "${data.length > 200 ? data.slice(0, 200) + "..." : data}"`, error);
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
    // Use consolidated cleanup method
    this.cleanupAssetState(assetId);
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
    await this.sendToQueue("FULL_L2_QUEUE", this.env.FULL_L2_QUEUE, fullL2Snapshot);
    this.lastFullL2SnapshotTs.set(event.asset_id, sourceTs);

    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const bidSize = bids[0]?.size ?? null;
    const askSize = asks[0]?.size ?? null;

    // Use consolidated BBO extraction (handles duplicate suppression)
    const snapshot = this.extractBBOSnapshot(
      event.asset_id,
      conditionId,
      sourceTs,
      ingestionTs,
      bestBid,
      bestAsk,
      bidSize,
      askSize,
      event.hash,
      tickSize,
      localBook.sequence
    );

    if (!snapshot) {
      return; // Duplicate, skip
    }

    // Queue for processing (async, goes through batching)
    await this.sendToQueue("SNAPSHOT_QUEUE", this.env.SNAPSHOT_QUEUE, snapshot);

    // LOW-LATENCY: Evaluate triggers immediately (bypasses queues)
    await this.evaluateTriggers(snapshot);
  }

  /**
   * Handle incremental price changes (critical for real-time accuracy)
   * This is where most orderbook updates come from - NOT book events
   *
   * OPTIMIZED: Tracks best bid/ask incrementally to avoid O(n log n) sorting on every update.
   * Only performs full scan when best level is removed.
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
        const preview = JSON.stringify(change);
        console.warn(`[WS] price_change missing asset_id in change:`, preview.length > 100 ? preview.slice(0, 100) + "..." : preview);
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

      // OPTIMIZATION: Track current best prices before changes
      // Get from lastQuotes cache (populated on book event and previous price changes)
      const cachedQuote = this.lastQuotes.get(assetId);
      let currentBestBid = cachedQuote?.bestBid ?? null;
      let currentBestAsk = cachedQuote?.bestAsk ?? null;
      let needsBidRescan = false;
      let needsAskRescan = false;

      // Apply deltas to local book and track level changes
      for (const change of changes) {
        const price = parseFloat(change.price);
        const newSize = parseFloat(change.size);
        const isBuy = change.side === "BUY";
        const book = isBuy ? localBook.bids : localBook.asks;
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

        // OPTIMIZATION: Update best price tracking incrementally
        if (isBuy) {
          if (newSize === 0 && price === currentBestBid) {
            // Best bid was removed - need to rescan
            needsBidRescan = true;
          } else if (newSize > 0 && (currentBestBid === null || price > currentBestBid)) {
            // New best bid
            currentBestBid = price;
          }
        } else {
          if (newSize === 0 && price === currentBestAsk) {
            // Best ask was removed - need to rescan
            needsAskRescan = true;
          } else if (newSize > 0 && (currentBestAsk === null || price < currentBestAsk)) {
            // New best ask
            currentBestAsk = price;
          }
        }

        // Update hash if provided in the change
        if (change.hash) {
          localBook.last_hash = change.hash;
        }
      }

      // Only rescan when best level was removed (O(n) instead of O(n log n))
      if (needsBidRescan) {
        currentBestBid = this.findBestBid(localBook.bids);
      }
      if (needsAskRescan) {
        currentBestAsk = this.findBestAsk(localBook.asks);
      }

      localBook.sequence++;
      localBook.last_update_ts = sourceTs;

      // Send level changes to queue (batch for efficiency)
      if (levelChanges.length > 0) {
        await this.sendBatchToQueue("LEVEL_CHANGE_QUEUE", this.env.LEVEL_CHANGE_QUEUE, levelChanges);
      }

      // Check if it's time for a periodic full L2 snapshot (every 5 minutes)
      const lastFullL2Ts = this.lastFullL2SnapshotTs.get(assetId) || 0;
      if (sourceTs - lastFullL2Ts >= this.FULL_L2_INTERVAL_MS) {
        // Use centralized sorting helper
        const sortedBids = this.getSortedLevels(localBook.bids, true);
        const sortedAsks = this.getSortedLevels(localBook.asks, false);

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

        await this.sendToQueue("FULL_L2_QUEUE", this.env.FULL_L2_QUEUE, fullL2Snapshot);
        this.lastFullL2SnapshotTs.set(assetId, sourceTs);
      }

      // Get sizes for best levels (O(1) lookup)
      const bidSize = currentBestBid !== null ? localBook.bids.get(currentBestBid) ?? null : null;
      const askSize = currentBestAsk !== null ? localBook.asks.get(currentBestAsk) ?? null : null;

      // Use consolidated BBO extraction (handles duplicate suppression)
      const snapshot = this.extractBBOSnapshot(
        assetId,
        conditionId,
        sourceTs,
        ingestionTs,
        currentBestBid,
        currentBestAsk,
        bidSize,
        askSize,
        localBook.last_hash,
        localBook.tick_size,
        localBook.sequence
      );

      if (!snapshot) {
        continue; // Duplicate, skip
      }

      // Queue for processing (async, goes through batching)
      await this.sendToQueue("SNAPSHOT_QUEUE", this.env.SNAPSHOT_QUEUE, snapshot);

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
    await this.sendToQueue("TRADE_QUEUE", this.env.TRADE_QUEUE, tradeTick);
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
    // Clear alarm tracking since we're now executing
    this.nextAlarmTime = null;

    const startTime = Date.now();
    let hasActiveConnections = false;
    let reconnectCount = 0;
    let pingCount = 0;

    // Check if we're still rate limited
    if (this.rateLimitedUntil > startTime) {
      const waitTime = this.rateLimitedUntil - startTime;
      console.log(`[Alarm] Rate limited, rescheduling in ${waitTime}ms`);
      await this.scheduleAlarm(waitTime + Math.random() * 1000);
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
      await this.scheduleAlarm(this.PING_INTERVAL_MS);
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
  // HELPER METHODS
  // ============================================================

  /**
   * Type guard for ErrorEvent - more type-safe than inline assertion
   */
  private isErrorEvent(event: Event): event is ErrorEvent {
    return "message" in event && typeof (event as ErrorEvent).message === "string";
  }

  /**
   * Safe queue send with error handling - prevents crashes from queue failures
   */
  private async sendToQueue<T>(
    queueName: string,
    queue: { send: (msg: T) => Promise<void> },
    message: T
  ): Promise<boolean> {
    try {
      await queue.send(message);
      return true;
    } catch (error) {
      console.error(`[Queue] Failed to send to ${queueName}:`, error);
      return false;
    }
  }

  /**
   * Safe batch queue send with error handling
   */
  private async sendBatchToQueue<T>(
    queueName: string,
    queue: { sendBatch: (messages: { body: T }[]) => Promise<void> },
    messages: T[]
  ): Promise<boolean> {
    try {
      await queue.sendBatch(messages.map((body) => ({ body })));
      return true;
    } catch (error) {
      console.error(`[Queue] Failed to send batch to ${queueName} (${messages.length} items):`, error);
      return false;
    }
  }

  /**
   * Schedule alarm with deduplication - prevents multiple alarms
   */
  private async scheduleAlarm(delayMs: number): Promise<void> {
    const targetTime = Date.now() + delayMs;

    // Only schedule if no alarm is set, or if this alarm should fire earlier
    if (this.nextAlarmTime === null || targetTime < this.nextAlarmTime) {
      await this.ctx.storage.setAlarm(targetTime);
      this.nextAlarmTime = targetTime;
    }
  }

  /**
   * Clean up all in-memory state for an asset - prevents memory leaks
   * Consolidated from handleUnsubscribe and removeAsset
   */
  private cleanupAssetState(assetId: string): void {
    this.tickSizes.delete(assetId);
    this.negRisk.delete(assetId);
    this.orderMinSizes.delete(assetId);
    this.localBooks.delete(assetId);
    this.lastQuotes.delete(assetId);
    this.lastFullL2SnapshotTs.delete(assetId);
    this.subscriptionFailures.delete(assetId);
    this.priceHistory.delete(assetId);
    this.latestBBO.delete(assetId);

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

  /**
   * Find best bid price from a Map - O(n) but only called when best level is removed
   */
  private findBestBid(bids: Map<number, number>): number | null {
    let best: number | null = null;
    for (const price of bids.keys()) {
      if (best === null || price > best) {
        best = price;
      }
    }
    return best;
  }

  /**
   * Find best ask price from a Map - O(n) but only called when best level is removed
   */
  private findBestAsk(asks: Map<number, number>): number | null {
    let best: number | null = null;
    for (const price of asks.keys()) {
      if (best === null || price < best) {
        best = price;
      }
    }
    return best;
  }

  /**
   * Extract BBO snapshot from orderbook data - consolidated logic
   * Returns null if this is a duplicate (top-of-book unchanged)
   */
  private extractBBOSnapshot(
    assetId: string,
    conditionId: string,
    sourceTs: number,
    ingestionTs: number,
    bestBid: number | null,
    bestAsk: number | null,
    bidSize: number | null,
    askSize: number | null,
    bookHash: string,
    tickSize: number,
    sequence: number
  ): BBOSnapshot | null {
    // Duplicate suppression - skip if top-of-book unchanged
    const lastQuote = this.lastQuotes.get(assetId);
    if (lastQuote && lastQuote.bestBid === bestBid && lastQuote.bestAsk === bestAsk) {
      return null; // Skip duplicate
    }
    this.lastQuotes.set(assetId, { bestBid, bestAsk });

    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const spreadBps = midPrice && spread ? (spread / midPrice) * 10000 : null;

    return {
      asset_id: assetId,
      token_id: assetId,
      condition_id: conditionId,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      book_hash: bookHash,
      best_bid: bestBid,
      best_ask: bestAsk,
      bid_size: bidSize,
      ask_size: askSize,
      mid_price: midPrice,
      spread_bps: spreadBps,
      tick_size: tickSize,
      is_resync: false,
      sequence_number: sequence,
      neg_risk: this.negRisk.get(assetId),
      order_min_size: this.orderMinSizes.get(assetId),
    };
  }

  /**
   * Get sorted levels from orderbook - centralized for consistency
   */
  private getSortedLevels(
    book: Map<number, number>,
    descending: boolean
  ): { price: number; size: number }[] {
    return Array.from(book.entries())
      .sort(descending ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0])
      .map(([price, size]) => ({ price, size }));
  }

  /**
   * Validate trigger condition parameters
   */
  private validateTriggerCondition(condition: Trigger["condition"]): string | null {
    if (typeof condition.threshold !== "number") {
      return "condition.threshold must be a number";
    }

    switch (condition.type) {
      case "PRICE_ABOVE":
      case "PRICE_BELOW":
        if (!condition.side || !["BID", "ASK"].includes(condition.side)) {
          return `${condition.type} requires condition.side to be "BID" or "ASK"`;
        }
        break;

      case "PRICE_MOVE":
        if (!condition.window_ms || typeof condition.window_ms !== "number") {
          return "PRICE_MOVE requires condition.window_ms (number)";
        }
        if (condition.window_ms > this.PRICE_HISTORY_MAX_AGE_MS) {
          return `window_ms cannot exceed ${this.PRICE_HISTORY_MAX_AGE_MS}ms`;
        }
        break;

      case "SIZE_SPIKE":
        if (!condition.side || !["BID", "ASK"].includes(condition.side)) {
          return "SIZE_SPIKE requires condition.side to be 'BID' or 'ASK'";
        }
        break;

      case "ARBITRAGE_BUY":
      case "ARBITRAGE_SELL":
        if (!condition.counterpart_asset_id) {
          return `${condition.type} requires condition.counterpart_asset_id`;
        }
        break;
    }

    return null;
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

      // Validate condition-specific parameters
      const validationError = this.validateTriggerCondition(body.condition);
      if (validationError) {
        return Response.json(
          { trigger_id: "", status: "error", message: validationError } as TriggerRegistration,
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
    // OPTIMIZATION: Only track history if we have active triggers (prevents memory leak)
    if (snapshot.mid_price !== null && triggerIdsToCheck.size > 0) {
      let history = this.priceHistory.get(snapshot.asset_id);
      if (!history) {
        history = [];
        this.priceHistory.set(snapshot.asset_id, history);
      }
      history.push({ ts: snapshot.source_ts, mid_price: snapshot.mid_price });

      // OPTIMIZATION: Prune old entries using slice instead of shift (O(n) vs O(n²))
      const cutoff = snapshot.source_ts - this.PRICE_HISTORY_MAX_AGE_MS;
      let firstValidIdx = 0;
      while (firstValidIdx < history.length && history[firstValidIdx].ts < cutoff) {
        firstValidIdx++;
      }
      // Also enforce max entries limit to prevent unbounded growth
      const startIdx = Math.max(firstValidIdx, history.length - this.MAX_PRICE_HISTORY_ENTRIES);
      if (startIdx > 0) {
        const newHistory = history.slice(startIdx);
        this.priceHistory.set(snapshot.asset_id, newHistory);
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

        // Fire webhook truly asynchronously using waitUntil
        // This ensures DO doesn't shutdown before webhook completes while not blocking the hot path
        this.ctx.waitUntil(
          this.dispatchTriggerWebhook(trigger, event).catch((err) =>
            console.error(`[Trigger] Webhook dispatch failed for ${triggerId}:`, err)
          )
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
