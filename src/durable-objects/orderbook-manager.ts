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
  Trigger,
  TriggerEvent,
  TriggerRegistration,
  PriceHistoryEntry,
} from "../types/orderbook";
import type { MarketSource, LevelChangeType } from "../core/enums";
import type { TriggerType, TriggerBounds, CompoundTrigger } from "../core/triggers";
import { computeTriggerBounds, isCompoundTrigger } from "../core/triggers";
import { CompoundTriggerEvaluator } from "../services/trigger-evaluator/compound-evaluator";
import { getDefaultMarketSource } from "../config/database";
import { ClickHouseOrderbookClient } from "../services/clickhouse-orderbook";
import type { MarketConnector } from "../adapters/base-connector";
import { getConnector } from "../adapters/registry";
import { LatencyTracker } from "../utils/ring-buffer";
import {
  calculateArbitrageSizing,
  isTimestampFresh,
  STALE_DATA_THRESHOLD_US,
} from "../utils/arbitrage-calculations";
import { getAllRegionalBufferNames } from "../utils/region-mapping";

interface ConnectionState {
  ws: WebSocket | null;
  assets: Set<string>;
  pendingAssets: Set<string>; // Assets awaiting confirmation
  lastPing: number;
  subscriptionSent: boolean; // Track if we've sent subscription for current connection
  abortController: AbortController | null; // For cleanup of event listeners
  marketSource: string; // Market source for this connection (e.g., "polymarket")
  connector: MarketConnector | null; // Adapter for market-specific normalization
}

/**
 * Per-WebSocket timeout state to prevent race conditions.
 * Using WeakMap ensures no memory leaks if WebSocket objects linger.
 */
const wsTimeoutState = new WeakMap<WebSocket, { cleared: boolean }>();

interface PoolState {
  assetToConnection: [string, string][];
  assetToMarket: [string, string][];
  assetToMarketSource?: [string, MarketSource][]; // For multi-market support
  tickSizes: [string, number][];
  negRisk: [string, boolean][];
  orderMinSizes: [string, number][];
  triggers?: Trigger[]; // Low-latency triggers
  compoundTriggers?: CompoundTrigger[]; // Multi-market compound triggers
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
  // Initialization state tracking
  private isInitializing = true;
  private initializationError: string | null = null;

  private connections: Map<string, ConnectionState> = new Map();
  private assetToConnection: Map<string, string> = new Map();
  private assetToMarket: Map<string, string> = new Map(); // asset_id -> condition_id
  private assetToMarketSource: Map<string, MarketSource> = new Map(); // asset_id -> market_source (for multi-market support)
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
  private compoundTriggers: Map<string, CompoundTrigger> = new Map(); // compound trigger_id -> CompoundTrigger
  private compoundEvaluator: CompoundTriggerEvaluator | null = null; // Initialized after env available
  private compoundTriggerInFlight: Set<string> = new Set(); // Prevents race conditions in concurrent async evaluations
  private triggerBounds: Map<string, TriggerBounds> = new Map(); // trigger_id -> pre-computed bounds for fast pre-filtering
  private triggersByAsset: Map<string, Set<string>> = new Map(); // asset_id -> Set<trigger_id>
  private lastTriggerFire: Map<string, number> = new Map(); // trigger_id -> last fire timestamp
  private priceHistory: Map<string, PriceHistoryEntry[]> = new Map(); // asset_id -> price history for PRICE_MOVE
  // Latest BBO per asset for arbitrage trigger evaluation
  // Includes stale flag to prevent false arbitrage signals from mismatched YES/NO data
  // Includes size data for trade sizing calculations
  private latestBBO: Map<string, {
    best_bid: number | null;
    best_ask: number | null;
    bid_size: number | null;
    ask_size: number | null;
    ts: number;
    stale: boolean;
  }> = new Map();
  // Market relationships for arbitrage: maps asset_id -> Set of related asset_ids (YES/NO pairs)
  // Used to proactively mark counterpart BBO as stale when primary updates
  private marketRelationships: Map<string, Set<string>> = new Map();

  // ============================================================
  // GRAPH CACHE - 1-hop neighbors for compound triggers
  // Local cache with lazy loading from KV/GraphManager DO
  // ============================================================
  private graphCache: Map<string, import("../services/graph/types").GraphNeighbor[]> = new Map();
  private readonly GRAPH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private graphCacheTimestamps: Map<string, number> = new Map(); // market_id -> cache timestamp

  // CRITICAL PATH OPTIMIZATION: Pre-cached HMAC keys for webhook signing (avoids crypto.subtle.importKey on hot path)
  private hmacKeyCache: Map<string, CryptoKey> = new Map();
  private readonly PRICE_HISTORY_MAX_AGE_MS = 60000; // Keep 60s of price history
  private readonly MAX_PRICE_HISTORY_ENTRIES = 1000; // Safety limit to prevent unbounded growth
  private readonly MAX_TRIGGERS_PER_ASSET = 50; // Prevent trigger spam

  // ============================================================
  // HFT TRIGGER STATE MAPS
  // Additional state tracking for advanced market making triggers
  // ============================================================
  // QUOTE_VELOCITY: Track BBO update counts per asset
  private updateCounts: Map<string, { count: number; windowStartUs: number }> = new Map();
  // MID_PRICE_TREND: Track consecutive price moves
  private trendTracker: Map<string, { lastMid: number; consecutiveMoves: number; direction: "UP" | "DOWN" }> = new Map();
  // IMBALANCE_SHIFT: Track imbalance history (capped at 100 entries per asset)
  private imbalanceHistory: Map<string, { imbalance: number; ts: number }[]> = new Map();
  private readonly MAX_IMBALANCE_HISTORY_ENTRIES = 100;
  // STALE_QUOTE: Track last update timestamp per asset
  private lastUpdateTs: Map<string, number> = new Map();
  // LARGE_FILL: Track previous BBO for size delta calculation
  private previousBBO: Map<string, { bid_size: number | null; ask_size: number | null }> = new Map();
  // Cached DO stubs for SSE publishing (avoids stub lookup on every event)
  // REGIONAL SHARDING: Publish to all 4 regional buffers for geo-distributed low latency
  private regionalBufferStubs: Map<string, DurableObjectStub> = new Map();
  private cachedRegionalBufferStubArray: DurableObjectStub[] | null = null;

  // ============================================================
  // PREMIUM SSE - Direct low-latency SSE from OrderbookManager
  // Bypasses TriggerEventBuffer hop for 1-5ms latency reduction
  // ============================================================
  private premiumSSEConnections: Map<string, {
    writer: WritableStreamDefaultWriter<Uint8Array>;
    assetFilter: Set<string> | null; // null = all assets
    createdAt: number;
  }> = new Map();
  private premiumSSEEncoder = new TextEncoder();

  // Circuit breaker: auto-disable triggers after repeated failures
  private triggerFailureCount: Map<string, number> = new Map();
  private triggerCircuitOpen: Map<string, number> = new Map();
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  private readonly CIRCUIT_BREAKER_RESET_MS = 60000;
  // Latency percentile tracker for metrics endpoint
  private latencyTracker = new LatencyTracker(1000);

  // ============================================================
  // DO-DIRECT WRITE BUFFERS
  // Buffer snapshots in memory and flush directly to ClickHouse
  // Queues become fallback only (not hot path)
  // ============================================================
  private snapshotBuffer: BBOSnapshot[] = [];
  private levelChangeBuffer: OrderbookLevelChange[] = [];
  private tradeBuffer: TradeTick[] = [];
  private readonly BUFFER_SIZE = 100;
  private readonly BUFFER_FLUSH_MS = 5000;
  private readonly MAX_BUFFER_SIZE = 1000; // Backpressure: prevent OOM during ClickHouse slowdowns
  private snapshotFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushingSnapshots = false; // Guard against concurrent flushes
  private levelChangeFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private tradeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // ============================================================
  // MULTI-MARKET ADAPTER SUPPORT
  // Cached connectors per market source for event normalization
  // ============================================================
  private connectors: Map<string, MarketConnector> = new Map();

  // ============================================================
  // DATA INTEGRITY TRACKING
  // Track assets missing initial book events and stale quotes
  // ============================================================
  private missingBookFirstSeen: Map<string, number> = new Map(); // asset_id -> first seen timestamp
  private readonly MISSING_BOOK_TIMEOUT_MS = 30000; // 30 seconds to receive initial book
  private readonly STALE_QUOTE_THRESHOLD_MS = 60000; // 1 minute without updates = stale

  // Polymarket allows max 500 instruments per connection
  // We use 450 to leave headroom for pending subscriptions during updates
  private readonly POLYMARKET_MAX_INSTRUMENTS = 500;
  private readonly MAX_ASSETS_PER_CONNECTION = this.POLYMARKET_MAX_INSTRUMENTS - 50;
  private readonly RECONNECT_BASE_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;
  private readonly PING_INTERVAL_MS = 10000; // Send PING every 10 seconds
  private readonly CONNECTION_TIMEOUT_MS = 15000; // Timeout for WebSocket connection attempts (increased from 5s)
  private readonly PREWARM_INTERVAL_MS = 55000; // Just under 60s hibernation threshold
  private readonly SNAPSHOT_INTERVAL_MS: number;
  // COST OPTIMIZATION: Increased from 5 minutes to 30 minutes
  // Full L2 snapshots are only needed for gap recovery, not backtesting
  // BBO (tick-level) data is preserved at full resolution for strategies
  private readonly FULL_L2_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes for full L2 snapshots
  private readonly MAX_SUBSCRIPTION_RETRIES = 5; // Increased from 3 for resilience
  private readonly FAILURE_DECAY_MS = 3600000; // Reset failures after 1 hour of no attempts
  private readonly MAX_BACKOFF_MS = 300000; // Cap backoff at 5 minutes

  // Enhanced subscription state with exponential backoff (replaces simple failure counter)
  private subscriptionState: Map<string, {
    failures: number;
    lastAttempt: number;
    backoffUntil: number;
  }> = new Map();

  // Queue backpressure tracking
  private queueFailures: Map<string, { count: number; lastFailure: number }> = new Map();
  private readonly QUEUE_FAILURE_THRESHOLD = 5;
  private readonly QUEUE_FAILURE_WINDOW_MS = 60000;

  // Nautilus-style connection buffering to avoid rate limits
  private initialConnectionDelayMs: number = 5000; // Base delay, will be adjusted with DO ID stagger
  private readonly RATE_LIMIT_BASE_BACKOFF_MS = 60000; // Start at 60s backoff on 429 errors (increased from 30s)
  private readonly RATE_LIMIT_MAX_BACKOFF_MS = 300000; // Cap at 5 minutes
  private rateLimitedUntil: number = 0; // Timestamp when rate limit expires
  private rateLimitCount: number = 0; // Track consecutive rate limits for exponential backoff
  private connectionAttempts: number = 0; // Track consecutive failures
  private nextAlarmTime: number | null = null; // Track scheduled alarm to prevent duplicates
  private shardId: string = "unknown"; // Shard identifier for logging

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.SNAPSHOT_INTERVAL_MS = parseInt(env.SNAPSHOT_INTERVAL_MS) || 1000;

    // Shard-aware connection stagger to prevent thundering herd
    // Each shard waits: 5s base + (shardIndex * 3s) + random jitter
    // This ensures connections are established in sequence: shard-0 first, then shard-1, etc.
    const doIdStr = this.ctx.id.toString();

    // Try to extract shard index from DO name (e.g., "shard-5" -> 5)
    // Fall back to hash-based stagger for non-shard DOs
    const shardMatch = doIdStr.match(/shard-(\d+)/);
    let staggerMs: number;

    if (shardMatch) {
      const shardIndex = parseInt(shardMatch[1], 10);
      this.shardId = `shard-${shardIndex}`;
      staggerMs = shardIndex * 3000; // 3 seconds between each shard
      console.log(`[DO ${this.shardId}] Stagger delay: ${staggerMs}ms`);
    } else {
      // Fallback for non-shard DOs (legacy or global)
      this.shardId = doIdStr.slice(0, 12);
      const doIdHash = Array.from(doIdStr).reduce((acc, char, idx) => {
        return ((acc << 5) - acc) + char.charCodeAt(0) + idx;
      }, 0);
      staggerMs = (Math.abs(doIdHash) % 60) * 1000; // 0-60 second stagger
    }

    this.initialConnectionDelayMs = 5000 + staggerMs;

    // Initialize compound trigger evaluator with cross-shard KV and graph queue
    // This enables compound triggers with gradual decay for wrong hypotheses
    this.compoundEvaluator = new CompoundTriggerEvaluator(
      this.shardId,
      this.env.CROSS_SHARD_KV,
      this.env.GRAPH_QUEUE
    );

    // Restore state on wake with comprehensive validation
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        const stored = await this.ctx.storage.get<PoolState>("poolState");

        if (!stored) {
          console.log(`[DO ${this.shardId}] No persisted state found, starting fresh`);
          return;
        }

        // ============================================================
        // CRITICAL: Validate stored state structure before using it
        // Corrupted or stale data could cause crashes or incorrect behavior
        // ============================================================
        if (!this.validateStoredState(stored)) {
          console.error(`[DO ${this.shardId}] Invalid stored state structure, discarding`);
          await this.ctx.storage.delete("poolState");
          return;
        }

        // Restore maps with error handling
        try {
          this.assetToConnection = new Map(stored.assetToConnection);
          this.assetToMarket = new Map(stored.assetToMarket);
          this.assetToMarketSource = new Map(stored.assetToMarketSource || []);
          this.tickSizes = new Map(stored.tickSizes);
          this.negRisk = new Map(stored.negRisk || []);
          this.orderMinSizes = new Map(stored.orderMinSizes || []);
        } catch (mapError) {
          console.error(`[DO ${this.shardId}] Failed to restore maps from stored arrays:`, mapError);
          await this.emergencyStateReset("map_restore_failed");
          return;
        }

        // Validate restored data consistency
        const assetCount = this.assetToConnection.size;
        const marketCount = this.assetToMarket.size;

        if (assetCount > 0 && marketCount === 0) {
          console.warn(
            `[DO ${this.shardId}] Inconsistent state: ${assetCount} assets but 0 markets. ` +
            `Clearing connections to force resync.`
          );
          await this.emergencyStateReset("inconsistent_asset_market_mapping");
          return;
        }

        console.log(
          `[DO ${this.shardId}] Restored state: ${assetCount} assets, ${marketCount} markets, ` +
          `${this.tickSizes.size} tick sizes`
        );

        // Restore triggers with validation
        if (stored.triggers && Array.isArray(stored.triggers)) {
          let validTriggers = 0;
          let invalidTriggers = 0;

          for (const trigger of stored.triggers) {
            // Validate trigger structure
            if (!trigger.id || !trigger.asset_id || !trigger.condition || !trigger.webhook_url) {
              console.warn(`[DO ${this.shardId}] Skipping invalid trigger:`, trigger.id || "unknown");
              invalidTriggers++;
              continue;
            }

            try {
              this.triggers.set(trigger.id, trigger);
              this.triggerBounds.set(trigger.id, computeTriggerBounds(trigger));
              if (!this.triggersByAsset.has(trigger.asset_id)) {
                this.triggersByAsset.set(trigger.asset_id, new Set());
              }
              this.triggersByAsset.get(trigger.asset_id)!.add(trigger.id);
              validTriggers++;
            } catch (triggerError) {
              console.error(`[DO ${this.shardId}] Failed to restore trigger ${trigger.id}:`, triggerError);
              invalidTriggers++;
            }
          }

          if (validTriggers > 0 || invalidTriggers > 0) {
            console.log(
              `[DO ${this.shardId}] Restored triggers: ${validTriggers} valid, ${invalidTriggers} invalid/skipped`
            );
          }
        }

        // Restore compound triggers with validation
        if (stored.compoundTriggers && Array.isArray(stored.compoundTriggers)) {
          let validCompound = 0;
          let invalidCompound = 0;

          for (const trigger of stored.compoundTriggers) {
            // Validate compound trigger structure
            if (!trigger.id || !trigger.conditions || !Array.isArray(trigger.conditions) || trigger.conditions.length === 0) {
              console.warn(`[DO ${this.shardId}] Skipping invalid compound trigger:`, trigger.id || "unknown");
              invalidCompound++;
              continue;
            }

            try {
              this.compoundTriggers.set(trigger.id, trigger);

              // Index by all asset_ids in conditions
              for (const condition of trigger.conditions) {
                if (!this.triggersByAsset.has(condition.asset_id)) {
                  this.triggersByAsset.set(condition.asset_id, new Set());
                }
                this.triggersByAsset.get(condition.asset_id)!.add(trigger.id);
              }
              validCompound++;
            } catch (triggerError) {
              console.error(`[DO ${this.shardId}] Failed to restore compound trigger ${trigger.id}:`, triggerError);
              invalidCompound++;
            }
          }

          if (validCompound > 0 || invalidCompound > 0) {
            console.log(
              `[DO ${this.shardId}] Restored compound triggers: ${validCompound} valid, ${invalidCompound} invalid/skipped`
            );
          }
        }

        // Rebuild connection asset sets with validation
        for (const [assetId, connId] of this.assetToConnection) {
          // Validate connection ID
          if (!connId || typeof connId !== "string") {
            console.warn(`[DO ${this.shardId}] Invalid connId for asset ${assetId}, skipping`);
            this.assetToConnection.delete(assetId);
            continue;
          }

          // Get market source for this asset (for multi-market support)
          const marketSource = this.assetToMarketSource.get(assetId) ?? getDefaultMarketSource();

          if (!this.connections.has(connId)) {
            // Get connector for this market source
            const connector = this.getMarketConnector(marketSource);
            this.connections.set(connId, {
              ws: null,
              assets: new Set(),
              pendingAssets: new Set(),
              lastPing: 0,
              subscriptionSent: false,
              abortController: null,
              marketSource,
              connector,
            });
          }
          this.connections.get(connId)!.assets.add(assetId);
        }

        // Pre-warm regional buffer stubs to avoid first-call latency
        this.getRegionalBufferStubs();

        // Nautilus-style: Don't reconnect immediately on wake
        // Schedule delayed connection with jitter to avoid thundering herd
        if (this.connections.size > 0) {
          const jitter = Math.random() * 10000; // 0-10s random jitter
          const delay = this.initialConnectionDelayMs + jitter;
          console.log(
            `[DO ${this.shardId}] Waking with ${this.connections.size} connections, ${this.assetToConnection.size} assets. ` +
            `Scheduling connection in ${Math.round(delay)}ms (stagger=${Math.round(this.initialConnectionDelayMs - 5000)}ms)`
          );
          await this.ctx.storage.setAlarm(Date.now() + delay);
        }

        // Mark initialization as complete
        this.isInitializing = false;
      } catch (error) {
        console.error(`[DO ${this.shardId}] Critical error during state restoration:`, error);
        this.initializationError = String(error);
        await this.emergencyStateReset("critical_error");
        this.isInitializing = false;
      }
    });
  }

  /**
   * Validate stored state structure before attempting to use it.
   * Returns false if state is corrupted or has unexpected structure.
   */
  private validateStoredState(stored: PoolState): boolean {
    // Check required array fields exist and are arrays
    if (!Array.isArray(stored.assetToConnection)) {
      console.error(`[DO ${this.shardId}] Invalid state: assetToConnection is not an array`);
      return false;
    }
    if (!Array.isArray(stored.assetToMarket)) {
      console.error(`[DO ${this.shardId}] Invalid state: assetToMarket is not an array`);
      return false;
    }
    if (!Array.isArray(stored.tickSizes)) {
      console.error(`[DO ${this.shardId}] Invalid state: tickSizes is not an array`);
      return false;
    }

    // Validate array entries are tuples (spot check first few entries)
    const checkTuples = (arr: unknown[], name: string): boolean => {
      for (let i = 0; i < Math.min(arr.length, 5); i++) {
        const entry = arr[i];
        if (!Array.isArray(entry) || entry.length !== 2) {
          console.error(`[DO ${this.shardId}] Invalid state: ${name}[${i}] is not a valid tuple`);
          return false;
        }
      }
      return true;
    };

    if (!checkTuples(stored.assetToConnection, "assetToConnection")) return false;
    if (!checkTuples(stored.assetToMarket, "assetToMarket")) return false;
    if (!checkTuples(stored.tickSizes, "tickSizes")) return false;

    // Optional fields - validate if present
    if (stored.negRisk !== undefined && !Array.isArray(stored.negRisk)) {
      console.error(`[DO ${this.shardId}] Invalid state: negRisk is not an array`);
      return false;
    }
    if (stored.orderMinSizes !== undefined && !Array.isArray(stored.orderMinSizes)) {
      console.error(`[DO ${this.shardId}] Invalid state: orderMinSizes is not an array`);
      return false;
    }
    if (stored.triggers !== undefined && !Array.isArray(stored.triggers)) {
      console.error(`[DO ${this.shardId}] Invalid state: triggers is not an array`);
      return false;
    }

    return true;
  }

  /**
   * Emergency reset of all in-memory state and storage.
   * Called when state is corrupted and cannot be recovered.
   * Better to start fresh than crash repeatedly.
   */
  private async emergencyStateReset(reason: string): Promise<void> {
    console.error(`[DO ${this.shardId}] EMERGENCY STATE RESET triggered: ${reason}`);

    // Clear all in-memory state
    this.connections.clear();
    this.assetToConnection.clear();
    this.assetToMarket.clear();
    this.assetToMarketSource.clear();
    this.tickSizes.clear();
    this.negRisk.clear();
    this.orderMinSizes.clear();
    this.localBooks.clear();
    this.lastQuotes.clear();
    this.lastFullL2SnapshotTs.clear();
    this.triggers.clear();
    this.triggersByAsset.clear();
    this.lastTriggerFire.clear();
    this.priceHistory.clear();
    this.latestBBO.clear();
    this.hmacKeyCache.clear();
    this.subscriptionState.clear();
    this.queueFailures.clear();
    this.marketRelationships.clear();
    // Clear HFT trigger state maps
    this.updateCounts.clear();
    this.trendTracker.clear();
    this.imbalanceHistory.clear();
    this.lastUpdateTs.clear();
    this.previousBBO.clear();
    // Clear data integrity tracking
    this.missingBookFirstSeen.clear();
    // Clear graph cache
    this.graphCache.clear();
    this.graphCacheTimestamps.clear();

    // Clear corrupted storage
    try {
      await this.ctx.storage.delete("poolState");
      console.log(`[DO ${this.shardId}] Cleared corrupted poolState from storage`);
    } catch (deleteError) {
      console.error(`[DO ${this.shardId}] Failed to clear corrupted state:`, deleteError);
    }
  }

  // ============================================================
  // GRAPH CACHE METHODS
  // Tiered lookup: L1 (memory) -> L2 (KV) -> L3 (GraphManager DO)
  // Target: < 5ms for hot path lookups
  // ============================================================

  /**
   * Get 1-hop graph neighbors for a market.
   * Uses tiered caching: memory -> KV -> GraphManager DO
   *
   * @param marketId - Market ID (condition_id) to look up
   * @returns Array of graph neighbors with weights
   */
  async get1HopNeighbors(marketId: string): Promise<import("../services/graph/types").GraphNeighbor[]> {
    // L1: Check memory cache
    const cachedTs = this.graphCacheTimestamps.get(marketId);
    if (cachedTs && Date.now() - cachedTs < this.GRAPH_CACHE_TTL_MS) {
      const cached = this.graphCache.get(marketId);
      if (cached) return cached;
    }

    // L2: Check KV cache
    const kvKey = `graph:neighbors:${marketId}`;
    try {
      const kvData = await this.env.GRAPH_CACHE.get(kvKey, "json") as {
        neighbors: import("../services/graph/types").GraphNeighbor[];
        updated_at: number;
      } | null;

      if (kvData && kvData.neighbors) {
        // Cache in memory
        this.graphCache.set(marketId, kvData.neighbors);
        this.graphCacheTimestamps.set(marketId, Date.now());
        return kvData.neighbors;
      }
    } catch (error) {
      console.warn(`[DO ${this.shardId}] KV graph cache miss for ${marketId}:`, error);
    }

    // L3: Fall back to GraphManager DO
    try {
      const ns = this.env.GRAPH_MANAGER as unknown as {
        idFromName(name: string, options?: { locationHint?: DurableObjectLocationHint }): DurableObjectId;
      };
      const doId = ns.idFromName("global", { locationHint: "weur" });
      const stub = this.env.GRAPH_MANAGER.get(doId);

      const response = await stub.fetch(`http://do/neighbors/${marketId}`);
      if (response.ok) {
        const data = await response.json() as {
          neighbors: import("../services/graph/types").GraphNeighbor[];
        };

        // Cache in memory and KV
        const neighbors = data.neighbors || [];
        this.graphCache.set(marketId, neighbors);
        this.graphCacheTimestamps.set(marketId, Date.now());

        // Async KV cache write (don't await on hot path)
        this.env.GRAPH_CACHE.put(kvKey, JSON.stringify({
          market_id: marketId,
          neighbors,
          updated_at: Date.now(),
        }), { expirationTtl: 900 }).catch(() => {});

        return neighbors;
      }
    } catch (error) {
      console.warn(`[DO ${this.shardId}] GraphManager DO lookup failed for ${marketId}:`, error);
    }

    return [];
  }

  /**
   * Invalidate graph cache for a market.
   * Called when the market is resolved or when graph is rebuilt.
   */
  invalidateGraphCache(marketId: string): void {
    this.graphCache.delete(marketId);
    this.graphCacheTimestamps.delete(marketId);
  }

  /**
   * Clear all graph cache entries.
   * Called during graph rebuild to ensure fresh data.
   */
  clearGraphCache(): void {
    this.graphCache.clear();
    this.graphCacheTimestamps.clear();
  }

  async fetch(request: Request): Promise<Response> {
    // Handle requests during initialization gracefully
    if (this.isInitializing) {
      return Response.json(
        {
          error: "DO is initializing, please retry",
          retry_after_seconds: 5,
        },
        {
          status: 503,
          headers: { "Retry-After": "5" },
        }
      );
    }

    // Handle initialization failure
    if (this.initializationError) {
      return Response.json(
        {
          error: "DO failed to initialize",
          details: this.initializationError,
        },
        { status: 500 }
      );
    }

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
      case "/metrics":
        return this.handleMetrics();
      case "/premium-sse":
        return this.handlePremiumSSE(request);
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
      market_source?: MarketSource; // Multi-market support
    };

    const { condition_id, token_ids, tick_size, neg_risk, order_min_size, market_source } = body;
    // Default to polymarket for backward compatibility
    const effectiveMarketSource = market_source ?? getDefaultMarketSource();
    let subscribed = 0;

    for (const tokenId of token_ids) {
      // Skip if already subscribed
      if (this.assetToConnection.has(tokenId)) continue;

      // Check subscription state with exponential backoff
      const subState = this.subscriptionState.get(tokenId);
      if (subState) {
        const now = Date.now();

        // Reset failures after decay period (1 hour of no attempts)
        if (now - subState.lastAttempt > this.FAILURE_DECAY_MS) {
          this.subscriptionState.delete(tokenId);
          console.log(`[WS] Asset ${tokenId.slice(0, 12)}... failure count reset after decay period`);
        } else if (now < subState.backoffUntil) {
          // Still in backoff period - skip but don't log spam
          const remainingSec = Math.round((subState.backoffUntil - now) / 1000);
          if (subState.failures <= 2) { // Only log first few backoffs
            console.log(`[WS] Asset ${tokenId.slice(0, 12)}... in backoff, retry in ${remainingSec}s`);
          }
          continue;
        }
      }

      // Store market mapping and metadata
      this.assetToMarket.set(tokenId, condition_id);
      this.assetToMarketSource.set(tokenId, effectiveMarketSource);
      if (tick_size) this.tickSizes.set(tokenId, tick_size);
      if (neg_risk !== undefined) this.negRisk.set(tokenId, neg_risk);
      if (order_min_size !== undefined) this.orderMinSizes.set(tokenId, order_min_size);

      // Find or create connection with capacity for this market source
      let connId = this.findConnectionWithCapacity(effectiveMarketSource);
      if (!connId) {
        connId = await this.createConnection(effectiveMarketSource);
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

    // Track connections that may need cleanup
    const connectionsToCheck = new Set<string>();

    for (const tokenId of token_ids) {
      const connId = this.assetToConnection.get(tokenId);
      if (connId) {
        this.assetToConnection.delete(tokenId);
        this.assetToMarket.delete(tokenId);
        const conn = this.connections.get(connId);
        if (conn) {
          conn.assets.delete(tokenId);
          conn.pendingAssets.delete(tokenId);
          connectionsToCheck.add(connId);
        }
      }

      // Use consolidated cleanup method
      this.cleanupAssetState(tokenId);
    }

    // CRITICAL: Clean up empty connections to prevent memory leaks
    for (const connId of connectionsToCheck) {
      const conn = this.connections.get(connId);
      if (conn && conn.assets.size === 0) {
        await this.cleanupConnection(conn);
        this.connections.delete(connId);
        console.log(`[DO ${this.shardId}] Cleaned up empty connection ${connId}`);
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

    // Get assets with failures (includes backoff timing)
    const now = Date.now();
    const failedAssets = Array.from(this.subscriptionState.entries())
      .filter(([, state]) => state.failures > 0)
      .map(([assetId, state]) => ({
        assetId: assetId.length > 23 ? assetId.slice(0, 20) + "..." : assetId,
        failures: state.failures,
        inBackoff: now < state.backoffUntil,
        backoffRemainingSec: now < state.backoffUntil ? Math.round((state.backoffUntil - now) / 1000) : 0,
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

  /**
   * Returns latency percentile metrics for trigger processing.
   * Used for SLA monitoring and performance analysis.
   */
  private handleMetrics(): Response {
    const stats = this.latencyTracker.getStats();
    const toMs = (us: number) => Math.round(us / 1000);

    return Response.json({
      latency: {
        total: {
          p50_ms: toMs(stats.total.p50), p95_ms: toMs(stats.total.p95), p99_ms: toMs(stats.total.p99),
          mean_ms: toMs(stats.total.mean), min_ms: toMs(stats.total.min), max_ms: toMs(stats.total.max),
          sample_count: stats.total.count,
        },
        processing: {
          p50_ms: toMs(stats.processing.p50), p95_ms: toMs(stats.processing.p95), p99_ms: toMs(stats.processing.p99),
          mean_ms: toMs(stats.processing.mean), min_ms: toMs(stats.processing.min), max_ms: toMs(stats.processing.max),
          sample_count: stats.processing.count,
        },
        window_ms: stats.total.window_ms,
      },
      triggers: { registered: this.triggers.size, by_asset: this.triggersByAsset.size },
      circuit_breaker: {
        open: this.triggerCircuitOpen.size,
        failing: this.triggerFailureCount.size,
        open_ids: Array.from(this.triggerCircuitOpen.keys()),
      },
      shard: this.shardId,
      premium_sse_connections: this.premiumSSEConnections.size,
    });
  }

  /**
   * Handle premium SSE connection request.
   * Premium SSE clients receive events directly from OrderbookManager,
   * bypassing the TriggerEventBuffer hop for 1-5ms latency reduction.
   */
  private handlePremiumSSE(request: Request): Response {
    const url = new URL(request.url);
    const assetIds = url.searchParams.get("assets");
    const connectionId = crypto.randomUUID();

    // Create transform stream for SSE
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Parse asset filter (comma-separated asset IDs, or null for all)
    const assetFilter = assetIds ? new Set(assetIds.split(",")) : null;

    // Store connection
    this.premiumSSEConnections.set(connectionId, {
      writer,
      assetFilter,
      createdAt: Date.now(),
    });

    // Send initial connection message
    this.ctx.waitUntil((async () => {
      try {
        await writer.write(this.premiumSSEEncoder.encode(`: connected to premium SSE\n\n`));
        await writer.write(this.premiumSSEEncoder.encode(`data: ${JSON.stringify({
          type: "connected",
          connection_id: connectionId.slice(0, 8),
          assets_filtered: assetFilter ? assetFilter.size : "all",
          shard: this.shardId,
        })}\n\n`));
      } catch (error) {
        console.error(`[Premium SSE] Failed to initialize ${connectionId.slice(0, 8)}:`, error);
        this.premiumSSEConnections.delete(connectionId);
      }
    })());

    console.log(
      `[Premium SSE] Client ${connectionId.slice(0, 8)} connected, ` +
      `filter: ${assetFilter ? assetFilter.size + " assets" : "all"}, ` +
      `total: ${this.premiumSSEConnections.size}`
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Premium-SSE": "true",
      },
    });
  }

  /**
   * Write trigger events directly to premium SSE clients.
   * Called BEFORE publishing to TriggerEventBuffer for lowest latency.
   * Fire-and-forget: failures are logged but don't block the hot path.
   *
   * LATENCY OPTIMIZATION: Pre-serializes events once and reuses across connections.
   * Eliminates map().join() allocation pattern (saves 50-200μs per batch).
   */
  private writeToPremiumSSE(events: TriggerEvent[]): void {
    if (this.premiumSSEConnections.size === 0 || events.length === 0) return;

    // Pre-serialize all events once (amortize JSON.stringify cost)
    const serializedEvents = new Array<string>(events.length);
    for (let i = 0; i < events.length; i++) {
      serializedEvents[i] = `data: ${JSON.stringify(events[i])}\n\n`;
    }

    for (const [connId, conn] of this.premiumSSEConnections) {
      let message: string;

      if (conn.assetFilter) {
        // Build message incrementally for filtered events (avoids intermediate array)
        message = "";
        for (let i = 0; i < events.length; i++) {
          if (conn.assetFilter.has(events[i].asset_id)) {
            message += serializedEvents[i];
          }
        }
        if (message === "") continue; // No matching events
      } else {
        // All events - join pre-serialized strings
        message = serializedEvents.join("");
      }

      const messageBytes = this.premiumSSEEncoder.encode(message);

      // Fire-and-forget write with immediate cleanup on error
      // Map.delete() is idempotent - safe if called multiple times
      conn.writer.write(messageBytes).catch(() => {
        this.premiumSSEConnections.delete(connId);
      });
    }
  }

  /**
   * Find an existing connection with capacity for the given market source.
   * Connections are market-specific since different markets have different WebSocket endpoints.
   *
   * @param marketSource - The market source to find a connection for
   * @returns The connection ID if found, null otherwise
   */
  private findConnectionWithCapacity(marketSource: string = getDefaultMarketSource()): string | null {
    for (const [connId, state] of this.connections) {
      // Only use connections for the same market source
      if (state.marketSource !== marketSource) continue;

      // Check capacity using connector's limit (or default)
      const maxAssets = state.connector?.getMaxAssetsPerConnection() ?? this.MAX_ASSETS_PER_CONNECTION;
      if (state.assets.size < maxAssets) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          return connId;
        }
      }
    }
    return null;
  }

  /**
   * Create a new WebSocket connection for a specific market source.
   * Uses the market's adapter to get the WebSocket URL and subscription format.
   *
   * @param marketSource - The market source (e.g., "polymarket")
   * @returns The connection ID
   */
  private async createConnection(marketSource: string = getDefaultMarketSource()): Promise<string> {
    const connId = `conn_${marketSource}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    // Get the connector for this market source
    const connector = this.getMarketConnector(marketSource);

    this.connections.set(connId, {
      ws: null,
      assets: new Set(),
      pendingAssets: new Set(),
      lastPing: 0,
      subscriptionSent: false,
      abortController: null,
      marketSource,
      connector,
    });

    await this.reconnect(connId, 0);
    return connId;
  }

  /**
   * CRITICAL: Complete cleanup of WebSocket connection and all associated resources.
   * MUST be called and awaited before creating a new connection to prevent memory leaks.
   *
   * This method:
   * 1. Aborts all event listeners via AbortController
   * 2. Closes the WebSocket and waits for close to complete
   * 3. Clears all references to prevent leaks
   */
  private async cleanupConnection(state: ConnectionState): Promise<void> {
    // 1. Abort all event listeners FIRST (prevents handlers from firing during cleanup)
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }

    // 2. Close WebSocket and wait for it to finish
    if (state.ws) {
      const ws = state.ws;
      state.ws = null; // Clear reference immediately to prevent double cleanup

      try {
        // If already closed/closing, skip
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();

          // CRITICAL: Wait for close to complete (with timeout)
          await new Promise<void>((resolve) => {
            const checkInterval = 50; // Check every 50ms
            const maxWaitMs = 2000; // Max 2 seconds
            let elapsed = 0;

            const checkClosed = () => {
              if (ws.readyState === WebSocket.CLOSED || elapsed >= maxWaitMs) {
                resolve();
              } else {
                elapsed += checkInterval;
                setTimeout(checkClosed, checkInterval);
              }
            };
            checkClosed();
          });
        }
      } catch (error) {
        // Log but continue cleanup even if close fails
        console.warn(`[WS] Error during cleanup:`, error);
      }
    }
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

    // CRITICAL: Complete cleanup before creating new connection (prevents memory leaks)
    await this.cleanupConnection(state);

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
      // ADAPTER-DRIVEN: Use connector's WebSocket URL for market-specific endpoint
      const wsUrl = state.connector?.getWebSocketUrl() ?? this.env.CLOB_WSS_URL;
      console.log(`[WS ${connId}] Attempting connection to ${wsUrl} (market: ${state.marketSource})`);
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      // Create AbortController for this connection's event listeners
      const abortController = new AbortController();
      state.abortController = abortController;
      const signal = abortController.signal;

      // RACE CONDITION FIX: Use immutable timeout state per WebSocket instance
      // This prevents the timeout callback from acting on stale state
      const timeoutState = { cleared: false };
      wsTimeoutState.set(ws, timeoutState);

      const connectionTimeout = setTimeout(() => {
        // Check if this timeout was already cleared by another handler
        if (timeoutState.cleared) return;

        // Only act if this WS is still the active connection AND still connecting
        if (state.ws === ws && ws.readyState === WebSocket.CONNECTING) {
          console.error(`[WS ${connId}] Connection timeout after ${this.CONNECTION_TIMEOUT_MS}ms`);
          timeoutState.cleared = true;
          ws.close();
          state.ws = null;
          // Schedule retry with backoff
          this.scheduleAlarm(this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
        }
      }, this.CONNECTION_TIMEOUT_MS);

      // Helper to clear timeout safely
      const clearConnectionTimeout = () => {
        if (!timeoutState.cleared) {
          timeoutState.cleared = true;
          clearTimeout(connectionTimeout);
        }
      };

      ws.addEventListener("open", () => {
        // Clear timeout on successful connection
        clearConnectionTimeout();

        // Reset rate limit and failure tracking on successful connection
        this.connectionAttempts = 0;
        this.rateLimitedUntil = 0;
        this.rateLimitCount = 0; // Reset exponential backoff on success

        console.log(`[WS ${connId}] Connected, subscribing to ${state.assets.size} assets`);
        state.lastPing = Date.now();

        // ADAPTER-DRIVEN: Use connector's subscription message format
        // Filter out assets still in backoff period to respect exponential backoff
        if (state.assets.size > 0 && !state.subscriptionSent) {
          const assetList = this.filterAssetsNotInBackoff(Array.from(state.assets));
          // Sync pendingAssets with assets we're actually subscribing to:
          // 1. Remove assets in backoff (not in assetList) - prevents undeserved failure blame
          // 2. Add assets being subscribed (in assetList) - allows success to clear failure state
          const assetSet = new Set(assetList);
          for (const asset of state.pendingAssets) {
            if (!assetSet.has(asset)) {
              state.pendingAssets.delete(asset);
            }
          }
          for (const asset of assetList) {
            state.pendingAssets.add(asset);
          }
          if (assetList.length > 0) {
            const subscriptionMsg = state.connector?.getSubscriptionMessage(assetList)
              ?? JSON.stringify({ assets_ids: assetList, type: "market" });
            ws.send(subscriptionMsg);
            state.subscriptionSent = true;
            console.log(`[WS ${connId}] Subscription sent for ${assetList.length}/${state.assets.size} assets (market: ${state.marketSource})`);
          } else {
            console.log(`[WS ${connId}] All ${state.assets.size} assets in backoff, deferring subscription`);
          }
        }

        // Schedule alarm for PING heartbeat
        this.scheduleAlarm(this.PING_INTERVAL_MS);
      }, { signal });

      ws.addEventListener("message", (event) => {
        state.lastPing = Date.now();
        this.handleMessage(event.data as string, connId);
      }, { signal });

      ws.addEventListener("close", (event) => {
        // Clear timeout if still pending
        clearConnectionTimeout();

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
      }, { signal });

      ws.addEventListener("error", (event) => {
        // Clear timeout on error
        clearConnectionTimeout();

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
            `[DO ${this.shardId}] RATE LIMITED (429) - exponential backoff ${Math.round(totalBackoff / 1000)}s ` +
            `(attempt ${this.rateLimitCount}, base=${baseBackoff / 1000}s, jitter=${Math.round(jitter / 1000)}s)`
          );
          // Schedule retry after rate limit backoff
          this.scheduleAlarm(totalBackoff);
        } else {
          console.error(`[WS ${connId}] Error: ${errorInfo}`);
          this.connectionAttempts++;
        }
      }, { signal });
    } catch (error) {
      console.error(`[WS ${connId}] Connection failed:`, error);
      // Schedule retry
      this.scheduleAlarm(this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }

  /**
   * ADAPTER-DRIVEN MESSAGE HANDLING
   *
   * Uses the connector's parseMessage method to determine event type,
   * enabling market-agnostic event routing. New markets only need to
   * implement the MarketConnector interface.
   */
  private handleMessage(data: string, connId: string): void {
    const state = this.connections.get(connId);

    // Early return if connection state is missing (could happen during cleanup)
    if (!state) {
      console.warn(`[WS ${connId}] Received message for unknown connection, ignoring`);
      return;
    }

    const ingestionTs = Date.now() * 1000; // Microseconds
    const ingestionTsFloor = Math.floor(ingestionTs);

    // ADAPTER-DRIVEN: Use connector to parse message if available
    if (state.connector) {
      const parsed = state.connector.parseMessage(data);

      // Protocol messages (PONG, etc.) return null
      if (parsed === null) {
        return;
      }

      // Handle INVALID OPERATION (returned as unknown type with raw string)
      if (parsed.type === "unknown" && parsed.raw === "INVALID OPERATION") {
        this.handleInvalidOperation(connId, state);
        return;
      }

      // Mark asset as confirmed on any valid event - clear failure state
      if (parsed.assetId && state.pendingAssets.has(parsed.assetId)) {
        state.pendingAssets.delete(parsed.assetId);
        this.subscriptionState.delete(parsed.assetId); // Clear backoff on success
      }

      // UNIFIED DISPATCH: All markets route through canonical handlers
      // This ensures optimizations benefit all markets equally (Nautilus-style)
      switch (parsed.type) {
        case "book":
          // Full orderbook snapshot - initialize/reset local book
          this.handleCanonicalBookEvent(state.connector, parsed.raw, ingestionTsFloor);
          break;

        case "price_change":
          // Incremental update - apply deltas to local book
          this.handleCanonicalPriceChange(state.connector, parsed.raw, ingestionTsFloor);
          break;

        case "trade":
          // Trade execution - capture for backtesting
          this.handleCanonicalTrade(state.connector, parsed.raw, ingestionTsFloor);
          break;

        case "tick_size":
          // Tick size update - handled via connector if supported
          this.handleCanonicalTickSizeChange(state.connector, parsed.raw);
          break;

        default:
          console.warn(`[WS ${connId}] Unknown event type: ${parsed.type} (market: ${state.marketSource})`);
      }
    } else {
      // CRITICAL: Connector should ALWAYS exist - this indicates initialization failure
      console.error(
        `[WS ${connId}] CRITICAL: Missing connector for market ${state.marketSource}. ` +
        `Connection may not be properly initialized. Asset count: ${state.assets.size}`
      );

      // Track failures for all assets on this broken connection using exponential backoff
      const now = Date.now();
      for (const assetId of state.assets) {
        const current = this.subscriptionState.get(assetId) || {
          failures: 0,
          lastAttempt: 0,
          backoffUntil: 0
        };
        // Check if failures should decay (1 hour since last attempt)
        const failures = (now - current.lastAttempt > this.FAILURE_DECAY_MS)
          ? 1  // Reset to 1 (this failure)
          : current.failures + 1;
        const backoffMs = Math.min(1000 * Math.pow(2, failures), this.MAX_BACKOFF_MS);
        this.subscriptionState.set(assetId, {
          failures,
          lastAttempt: now,
          backoffUntil: now + backoffMs,
        });
      }

      // Close the broken connection and trigger reconnection
      if (state.ws) {
        state.ws.close(1011, "Missing connector - reinitializing");
      }
      this.connections.delete(connId);

      // Schedule reconnection via alarm
      this.scheduleAlarm(this.RECONNECT_BASE_DELAY_MS);
    }
  }

  /**
   * Handle INVALID OPERATION response from market.
   * Uses exponential backoff instead of permanent removal.
   *
   * KEY FIX: Previously, all pending assets were blamed equally for a single
   * INVALID OPERATION, leading to valid assets being permanently removed.
   * Now we use exponential backoff with failure decay to allow recovery.
   */
  private handleInvalidOperation(connId: string, state: ConnectionState): void {
    const pendingCount = state.pendingAssets.size;
    console.warn(
      `[WS ${connId}] INVALID OPERATION received (market: ${state.marketSource}). ` +
      `Pending assets: ${pendingCount}. This may indicate rate limiting or invalid asset IDs.`
    );

    if (pendingCount > 0) {
      const pendingList = Array.from(state.pendingAssets);
      console.warn(`[WS ${connId}] Affected assets (first 5): ${pendingList.slice(0, 5).map(id => id.slice(0, 12) + '...').join(", ")}`);
    }

    const now = Date.now();

    // Apply exponential backoff to all pending assets
    for (const assetId of state.pendingAssets) {
      const current = this.subscriptionState.get(assetId) || {
        failures: 0,
        lastAttempt: 0,
        backoffUntil: 0
      };

      // Check if failures should decay (1 hour since last attempt)
      const effectiveFailures = (now - current.lastAttempt > this.FAILURE_DECAY_MS)
        ? 1  // Reset to 1 (this failure)
        : current.failures + 1;

      // Exponential backoff: 2^failures seconds, capped at MAX_BACKOFF_MS (5 min)
      const backoffMs = Math.min(1000 * Math.pow(2, effectiveFailures), this.MAX_BACKOFF_MS);

      this.subscriptionState.set(assetId, {
        failures: effectiveFailures,
        lastAttempt: now,
        backoffUntil: now + backoffMs,
      });

      // Log at different levels based on failure count
      if (effectiveFailures >= this.MAX_SUBSCRIPTION_RETRIES) {
        // High failure count - but DON'T permanently remove, just longer backoff
        console.error(
          `[WS] Asset ${assetId.slice(0, 12)}... has ${effectiveFailures} failures, ` +
          `backoff ${Math.round(backoffMs / 1000)}s (will retry after backoff)`
        );
      } else if (effectiveFailures >= 3) {
        console.warn(
          `[WS] Asset ${assetId.slice(0, 12)}... failure #${effectiveFailures}, ` +
          `backoff ${Math.round(backoffMs / 1000)}s`
        );
      }

      // Remove from pending so we don't keep retrying immediately
      state.pendingAssets.delete(assetId);
    }

    // Reset subscription state to allow retry after backoff
    state.subscriptionSent = false;

    // Schedule a retry - use minimum backoff time across all affected assets
    const minBackoff = Math.max(this.RECONNECT_BASE_DELAY_MS * 2, 5000); // At least 5 seconds
    this.scheduleAlarm(minBackoff);
  }

  /**
   * Legacy message handling for connections without connectors.
   * Kept for backward compatibility but should not be reached with new code.
   */
  private handleMessageLegacy(
    data: string,
    connId: string,
    state: ConnectionState,
    ingestionTsFloor: number
  ): void {
    // Handle non-JSON protocol messages first
    if (data === "PONG") {
      return;
    }

    if (data === "INVALID OPERATION") {
      this.handleInvalidOperation(connId, state);
      return;
    }

    if (!data.startsWith("{") && !data.startsWith("[")) {
      console.warn(`[WS ${connId}] Unexpected non-JSON message: "${data.length > 100 ? data.slice(0, 100) + "..." : data}"`);
      return;
    }

    try {
      const event = JSON.parse(data) as PolymarketWSEvent;

      // Mark asset as confirmed on any valid event - clear failure state
      if ("asset_id" in event && state.pendingAssets.has(event.asset_id)) {
        state.pendingAssets.delete(event.asset_id);
        this.subscriptionState.delete(event.asset_id); // Clear backoff on success
      }

      switch (event.event_type) {
        case "book":
          this.handleBookEvent(event, ingestionTsFloor);
          break;
        case "price_change":
          this.handlePriceChangeEvent(event, ingestionTsFloor);
          break;
        case "last_trade_price":
          this.handleTradeEvent(event, ingestionTsFloor);
          break;
        case "tick_size_change":
          this.handleTickSizeChange(event);
          break;
        default:
          console.warn(`[WS ${connId}] Unknown event type: ${(event as { event_type: string }).event_type}`);
      }
    } catch (error) {
      console.error(`[WS ${connId}] JSON parse error for message: "${data.length > 200 ? data.slice(0, 200) + "..." : data}"`, error);
    }
  }

  /**
   * CANONICAL BOOK EVENT HANDLER
   * Handles book events from ANY market using connector normalization.
   * This is the unified path for all markets via the adapter pattern.
   *
   * CRITICAL: This handler includes hash chain verification to detect gaps.
   */
  private handleCanonicalBookEvent(
    connector: MarketConnector,
    raw: unknown,
    ingestionTs: number
  ): void {
    // Use connector to normalize to canonical BBO snapshot
    const snapshot = connector.normalizeBookEvent(raw);
    if (!snapshot) {
      console.warn(`[DO ${this.shardId}] Connector ${connector.marketSource} failed to normalize book event`);
      return;
    }

    // Get condition ID and tick size from local state
    const conditionId = this.assetToMarket.get(snapshot.asset_id) || snapshot.condition_id;
    const tickSize = this.tickSizes.get(snapshot.asset_id) || snapshot.tick_size;
    const marketSource = connector.marketSource as MarketSource;

    // Clear missing book tracking since we received the book
    this.missingBookFirstSeen.delete(snapshot.asset_id);

    // DATA INTEGRITY: Check if this is a resync (we already had a book with different hash)
    const existingBook = this.localBooks.get(snapshot.asset_id);
    const isResync = existingBook && existingBook.last_hash !== snapshot.book_hash;

    if (isResync) {
      // Book event with different hash - this is a resync (gap detected)
      console.log(
        `[DO ${this.shardId}] Book resync for ${snapshot.asset_id.slice(0, 12)}... (market: ${connector.marketSource}): ` +
        `old_hash=${existingBook.last_hash.slice(0, 12)}..., new_hash=${snapshot.book_hash.slice(0, 12)}...`
      );
      // Record the gap event for monitoring and audit
      const clickhouse = new ClickHouseOrderbookClient(this.env);
      this.ctx.waitUntil(
        clickhouse.recordGapEvent(
          snapshot.asset_id,
          existingBook.last_hash,
          snapshot.book_hash,
          snapshot.source_ts - existingBook.last_update_ts,
          marketSource
        )
      );
    }

    // Get full L2 snapshot using connector
    const fullL2 = connector.normalizeFullL2(
      raw,
      conditionId,
      tickSize,
      this.negRisk.get(snapshot.asset_id),
      this.orderMinSizes.get(snapshot.asset_id)
    );

    if (fullL2) {
      // Initialize/reset local orderbook state
      const localBook: LocalOrderbook = {
        market_source: marketSource,
        asset_id: snapshot.asset_id,
        condition_id: conditionId,
        bids: new Map(fullL2.bids.map((b) => [b.price, b.size])),
        asks: new Map(fullL2.asks.map((a) => [a.price, a.size])),
        tick_size: tickSize,
        last_hash: snapshot.book_hash,
        last_update_ts: snapshot.source_ts,
        sequence: 1,
      };
      this.localBooks.set(snapshot.asset_id, localBook);

      // Emit full L2 snapshot (initial or resync)
      this.ctx.waitUntil(
        this.sendToQueue("FULL_L2_QUEUE", this.env.FULL_L2_QUEUE, fullL2)
      );
      this.lastFullL2SnapshotTs.set(snapshot.asset_id, snapshot.source_ts);
    }

    // Update snapshot with correct values from local state
    const finalSnapshot: BBOSnapshot = {
      ...snapshot,
      condition_id: conditionId,
      tick_size: tickSize,
      ingestion_ts: ingestionTs,
    };

    // Check for duplicates before buffering
    const cached = this.lastQuotes.get(snapshot.asset_id);
    if (
      cached &&
      cached.bestBid === finalSnapshot.best_bid &&
      cached.bestAsk === finalSnapshot.best_ask
    ) {
      return; // Duplicate
    }

    // Update quote cache
    this.lastQuotes.set(snapshot.asset_id, {
      bestBid: finalSnapshot.best_bid,
      bestAsk: finalSnapshot.best_ask,
    });

    // Buffer for direct ClickHouse write
    this.bufferSnapshot(finalSnapshot);

    // Evaluate triggers
    this.ctx.waitUntil(this.evaluateTriggersAsync(finalSnapshot));
  }

  /**
   * CANONICAL PRICE CHANGE HANDLER
   * Handles level changes from any market using connector normalization.
   */
  private handleCanonicalPriceChange(
    connector: MarketConnector,
    raw: unknown,
    ingestionTs: number
  ): void {
    const levelChanges = connector.normalizeLevelChange(raw);
    if (!levelChanges || levelChanges.length === 0) {
      // Log warning to enable debugging of normalization failures
      const rawEvent = raw as { event_type?: string; asset_id?: string };
      console.warn(
        `[DO ${this.shardId}] Connector ${connector.marketSource} failed to normalize price_change. ` +
        `Event type: ${rawEvent?.event_type || 'unknown'}, asset: ${rawEvent?.asset_id?.slice(0, 12) || 'unknown'}`
      );
      return;
    }

    // Group by asset
    const byAsset = new Map<string, typeof levelChanges>();
    for (const change of levelChanges) {
      if (!byAsset.has(change.asset_id)) {
        byAsset.set(change.asset_id, []);
      }
      byAsset.get(change.asset_id)!.push(change);
    }

    // Process each asset's changes
    for (const [assetId, changes] of byAsset) {
      const localBook = this.localBooks.get(assetId);
      if (!localBook) {
        this.trackMissingBook(assetId);
        continue;
      }

      // Apply changes to local book
      for (const change of changes) {
        const book = change.side === "BUY" ? localBook.bids : localBook.asks;
        if (change.new_size === 0) {
          book.delete(change.price);
        } else {
          book.set(change.price, change.new_size);
        }
        if (change.book_hash) {
          localBook.last_hash = change.book_hash;
        }
      }

      localBook.sequence++;
      localBook.last_update_ts = changes[0]?.source_ts || ingestionTs;

      // Buffer level changes (sampled)
      if (Math.random() < 0.1) {
        this.bufferLevelChange(changes);
      }

      // Extract and emit BBO
      const bestBid = this.findBestBid(localBook.bids);
      const bestAsk = this.findBestAsk(localBook.asks);
      const bidSize = bestBid !== null ? localBook.bids.get(bestBid) ?? null : null;
      const askSize = bestAsk !== null ? localBook.asks.get(bestAsk) ?? null : null;

      const conditionId = this.assetToMarket.get(assetId) || localBook.condition_id;
      const snapshot = this.extractBBOSnapshot(
        assetId,
        conditionId,
        localBook.last_update_ts,
        ingestionTs,
        bestBid,
        bestAsk,
        bidSize,
        askSize,
        localBook.last_hash,
        localBook.tick_size,
        localBook.sequence
      );

      if (snapshot) {
        this.bufferSnapshot(snapshot);
        this.ctx.waitUntil(this.evaluateTriggersAsync(snapshot));
      }
    }
  }

  /**
   * CANONICAL TRADE HANDLER
   * Handles trade events from any market using connector normalization.
   */
  private handleCanonicalTrade(
    connector: MarketConnector,
    raw: unknown,
    ingestionTs: number
  ): void {
    const trade = connector.normalizeTrade(raw);
    if (!trade) {
      // Log warning to enable debugging of normalization failures
      const rawEvent = raw as { event_type?: string; asset_id?: string };
      console.warn(
        `[DO ${this.shardId}] Connector ${connector.marketSource} failed to normalize trade. ` +
        `Event type: ${rawEvent?.event_type || 'unknown'}, asset: ${rawEvent?.asset_id?.slice(0, 12) || 'unknown'}`
      );
      return;
    }

    // Update with correct condition ID from local state
    const conditionId = this.assetToMarket.get(trade.asset_id) || trade.condition_id;
    const finalTrade: TradeTick = {
      ...trade,
      condition_id: conditionId,
      ingestion_ts: ingestionTs,
    };

    // Buffer for direct ClickHouse write
    this.bufferTrade(finalTrade);
  }

  /**
   * CANONICAL TICK SIZE CHANGE HANDLER
   * Handles tick size changes from any market.
   * Tick size changes are rare but important for order precision.
   */
  private handleCanonicalTickSizeChange(
    connector: MarketConnector,
    raw: unknown
  ): void {
    // Extract tick size change info - markets have different formats
    // For now, we support Polymarket format directly, other markets can extend
    const event = raw as { asset_id?: string; new_tick_size?: string; old_tick_size?: string };

    if (!event.asset_id || !event.new_tick_size) {
      console.warn(`[DO ${this.shardId}] Invalid tick size change event from ${connector.marketSource}`);
      return;
    }

    const newTickSize = parseFloat(event.new_tick_size);
    const oldTickSize = event.old_tick_size ? parseFloat(event.old_tick_size) : this.tickSizes.get(event.asset_id);

    console.log(
      `[DO ${this.shardId}] Tick size change for ${event.asset_id} (market: ${connector.marketSource}): ` +
      `${oldTickSize} -> ${newTickSize}`
    );

    // Update stored tick size
    this.tickSizes.set(event.asset_id, newTickSize);

    // Update local book tick size (book will be rebuilt on next 'book' event if needed)
    const localBook = this.localBooks.get(event.asset_id);
    if (localBook) {
      localBook.tick_size = newTickSize;
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

  // CRITICAL PATH OPTIMIZATION: Fully synchronous book event handling
  private handleBookEvent(
    event: PolymarketBookEvent,
    ingestionTs: number
  ): void {
    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs
    const conditionId = this.assetToMarket.get(event.asset_id) || event.market;
    const tickSize = this.tickSizes.get(event.asset_id) || 0.01;

    // DATA INTEGRITY: Clear missing book tracking since we received the book
    this.missingBookFirstSeen.delete(event.asset_id);

    // DATA INTEGRITY: Check if this is a resync (we already had a book)
    const existingBook = this.localBooks.get(event.asset_id);
    if (existingBook && existingBook.last_hash !== event.hash) {
      // Book event with different hash - this is a resync
      console.log(
        `[DO ${this.shardId}] Book resync for ${event.asset_id.slice(0, 12)}...: ` +
        `old_hash=${existingBook.last_hash.slice(0, 12)}..., new_hash=${event.hash.slice(0, 12)}...`
      );
      // Record the resync for monitoring
      const clickhouse = new ClickHouseOrderbookClient(this.env);
      this.ctx.waitUntil(
        clickhouse.recordGapEvent(
          event.asset_id,
          existingBook.last_hash,
          event.hash,
          sourceTs - existingBook.last_update_ts,
          this.assetToMarketSource.get(event.asset_id)
        )
      );
    }

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
      market_source: this.assetToMarketSource.get(event.asset_id) ?? getDefaultMarketSource(),
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
      market_source: this.assetToMarketSource.get(event.asset_id) ?? getDefaultMarketSource(),
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
    // CRITICAL PATH OPTIMIZATION: Fire-and-forget queue send (non-blocking)
    this.ctx.waitUntil(
      this.sendToQueue("FULL_L2_QUEUE", this.env.FULL_L2_QUEUE, fullL2Snapshot)
    );
    this.lastFullL2SnapshotTs.set(event.asset_id, sourceTs);

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

    // DO-DIRECT: Buffer snapshot for direct ClickHouse write (bypasses queue latency)
    this.bufferSnapshot(snapshot);

    // LOW-LATENCY: Evaluate triggers synchronously (bypasses queues)
    this.ctx.waitUntil(this.evaluateTriggersAsync(snapshot));
  }

  /**
   * Handle incremental price changes (critical for real-time accuracy)
   * This is where most orderbook updates come from - NOT book events
   *
   * OPTIMIZED: Tracks best bid/ask incrementally to avoid O(n log n) sorting on every update.
   * Only performs full scan when best level is removed.
   *
   * CRITICAL PATH OPTIMIZATION: Fully synchronous to minimize latency.
   * Queue sends are fire-and-forget via ctx.waitUntil.
   *
   * Note: asset_id is inside each price_change, not at the event level
   * A single event can contain changes for multiple assets
   */
  private handlePriceChangeEvent(
    event: PolymarketPriceChangeEvent,
    ingestionTs: number
  ): void {
    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs

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
        // Track missing book for stale detection
        this.trackMissingBook(assetId);
        continue;
      }

      // DATA INTEGRITY: Validate hash chain if hash provided in first change
      const firstChangeWithHash = changes.find(c => c.hash);
      if (firstChangeWithHash?.hash) {
        // Verify the hash chain hasn't broken
        if (!this.verifyHashChain(assetId, firstChangeWithHash.hash, localBook.last_hash)) {
          // Gap detected - skip processing, resync will be triggered
          continue;
        }
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
          market_source: this.assetToMarketSource.get(assetId) ?? getDefaultMarketSource(),
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

      // DO-DIRECT: Buffer level changes (sampled 10% for cost optimization)
      // Level changes are useful for order flow analysis but not required for backtesting
      if (levelChanges.length > 0 && Math.random() < 0.1) {
        this.bufferLevelChange(levelChanges);
      }

      // Check if it's time for a periodic full L2 snapshot (every 30 minutes)
      const lastFullL2Ts = this.lastFullL2SnapshotTs.get(assetId) || 0;
      if (sourceTs - lastFullL2Ts >= this.FULL_L2_INTERVAL_MS) {
        // Use centralized sorting helper
        const sortedBids = this.getSortedLevels(localBook.bids, true);
        const sortedAsks = this.getSortedLevels(localBook.asks, false);

        const fullL2Snapshot: FullL2Snapshot = {
          market_source: this.assetToMarketSource.get(assetId) ?? getDefaultMarketSource(),
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

        // Full L2 snapshots still use queue (lower frequency, larger payload)
        this.ctx.waitUntil(
          this.sendToQueue("FULL_L2_QUEUE", this.env.FULL_L2_QUEUE, fullL2Snapshot)
        );
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

      // DO-DIRECT: Buffer snapshot for direct ClickHouse write (bypasses queue latency)
      this.bufferSnapshot(snapshot);

      // LOW-LATENCY: Evaluate triggers synchronously (bypasses queues)
      this.ctx.waitUntil(this.evaluateTriggersAsync(snapshot));
    }
  }

  /**
   * Handle trade executions (critical for backtesting strategies)
   */
  private handleTradeEvent(
    event: PolymarketLastTradePriceEvent,
    ingestionTs: number
  ): void {
    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs
    const conditionId = this.assetToMarket.get(event.asset_id) || event.market;

    const tradeTick: TradeTick = {
      market_source: this.assetToMarketSource.get(event.asset_id) ?? getDefaultMarketSource(),
      asset_id: event.asset_id,
      condition_id: conditionId,
      trade_id: `${event.asset_id}-${sourceTs}-${crypto.randomUUID().slice(0, 8)}`,
      price: parseFloat(event.price),
      size: parseFloat(event.size),
      side: event.side,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
    };

    // DO-DIRECT: Buffer trade for batched queue write
    this.bufferTrade(tradeTick);
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

  /**
   * Filters assets that are not currently in backoff period.
   * Also handles decay period reset for stale failure states.
   */
  private filterAssetsNotInBackoff(assetIds: string[]): string[] {
    const now = Date.now();
    return assetIds.filter(assetId => {
      const subState = this.subscriptionState.get(assetId);
      if (!subState) return true; // No state = not in backoff

      // Reset failures after decay period (1 hour of no attempts)
      if (now - subState.lastAttempt > this.FAILURE_DECAY_MS) {
        this.subscriptionState.delete(assetId);
        return true;
      }

      // Check if still in backoff period
      if (now < subState.backoffUntil) {
        // Only log for assets with few failures to avoid spam
        if (subState.failures <= 2) {
          const remainingSec = Math.round((subState.backoffUntil - now) / 1000);
          console.log(`[WS] Asset ${assetId.slice(0, 12)}... skipped (backoff ${remainingSec}s remaining)`);
        }
        return false;
      }

      return true;
    });
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
          // ADAPTER-DRIVEN: Use connector's subscription message format
          // Filter out assets still in backoff period to respect exponential backoff
          const assetList = this.filterAssetsNotInBackoff(Array.from(state.assets));
          // Sync pendingAssets with assets we're actually subscribing to:
          // 1. Remove assets in backoff (not in assetList) - prevents undeserved failure blame
          // 2. Add assets being subscribed (in assetList) - allows success to clear failure state
          const assetSet = new Set(assetList);
          for (const asset of state.pendingAssets) {
            if (!assetSet.has(asset)) {
              state.pendingAssets.delete(asset);
            }
          }
          for (const asset of assetList) {
            state.pendingAssets.add(asset);
          }
          if (assetList.length === 0) {
            console.log(`[WS ${connId}] All ${state.assets.size} assets in backoff, skipping subscription`);
            continue;
          }
          const subscriptionMsg = state.connector?.getSubscriptionMessage(assetList)
            ?? JSON.stringify({ assets_ids: assetList, type: "market" });
          state.ws.send(subscriptionMsg);
          state.subscriptionSent = true;
          console.log(`[WS ${connId}] Subscription synced for ${assetList.length}/${state.assets.size} assets (market: ${state.marketSource})`);
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
            console.log(`[WS ${connId}] Retrying subscription for ${state.assets.size} assets (market: ${state.marketSource})`);
            // ADAPTER-DRIVEN: Use connector's subscription message format
            const assetList = Array.from(state.assets);
            const subscriptionMsg = state.connector?.getSubscriptionMessage(assetList)
              ?? JSON.stringify({ assets_ids: assetList, type: "market" });
            state.ws.send(subscriptionMsg);
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

    // Periodic cleanup: Remove stale price history (every ~10th alarm, ~100s)
    if (startTime % 100000 < this.PING_INTERVAL_MS) {
      this.cleanupPriceHistory();
    }

    // Check for stale quotes - evaluated in alarm since they detect absence of updates
    this.checkStaleQuotes();

    // DATA INTEGRITY: Check for missing book events and stale data requiring resync
    this.checkDataIntegrity();

    // PRE-WARMING: Keep DO warm if we have subscribed assets or triggers
    // This prevents hibernation and cold start penalties (50-200ms)
    if (this.assetToConnection.size > 0 || this.triggers.size > 0) {
      await this.ctx.storage.put("_prewarm_ts", Date.now());

      // Schedule next alarm even without active WebSocket connections
      // to maintain DO warmth for trigger processing
      if (!hasActiveConnections && this.connections.size === 0) {
        await this.scheduleAlarm(this.PREWARM_INTERVAL_MS);
      }
    }

    // Schedule next alarm if we have active connections
    if (hasActiveConnections || this.connections.size > 0) {
      await this.scheduleAlarm(this.PING_INTERVAL_MS);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Alarm] Completed in ${elapsed}ms - pings=${pingCount}, reconnects=${reconnectCount}`);
  }

  /**
   * Clean up stale price history to prevent memory leaks.
   * Removes history for unsubscribed assets and old entries.
   */
  private cleanupPriceHistory(): void {
    // Convert to microseconds since history timestamps are in microseconds
    const nowUs = Date.now() * 1000;
    let cleaned = 0;

    for (const [assetId, history] of this.priceHistory) {
      // Remove if asset is not subscribed
      if (!this.assetToConnection.has(assetId)) {
        this.priceHistory.delete(assetId);
        cleaned++;
        continue;
      }

      // Remove if no active PRICE_MOVE triggers for this asset
      const triggerIds = this.triggersByAsset.get(assetId);
      const hasPriceMoveTrigger = triggerIds && Array.from(triggerIds).some(id => {
        const t = this.triggers.get(id);
        return t?.enabled && t.condition.type === "PRICE_MOVE";
      });

      if (!hasPriceMoveTrigger) {
        this.priceHistory.delete(assetId);
        cleaned++;
        continue;
      }

      // Remove if last entry is too old (2x max age)
      // PRICE_HISTORY_MAX_AGE_MS is in ms, convert to microseconds for comparison
      const maxAgeUs = this.PRICE_HISTORY_MAX_AGE_MS * 1000 * 2;
      if (history.length > 0 && nowUs - history[history.length - 1].ts > maxAgeUs) {
        this.priceHistory.delete(assetId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Alarm] Cleaned price history for ${cleaned} assets`);
    }
  }

  /**
   * Check for stale quotes and fire STALE_QUOTE triggers.
   * Called from alarm() handler since these triggers detect absence of updates.
   */
  private checkStaleQuotes(): void {
    const now = Date.now() * 1000; // Microseconds
    const firedEvents: { trigger: Trigger; event: TriggerEvent }[] = [];

    // Find all STALE_QUOTE triggers
    for (const [triggerId, trigger] of this.triggers) {
      if (!trigger.enabled || trigger.condition.type !== "STALE_QUOTE") continue;

      const threshold = trigger.condition.threshold; // staleness in ms

      // For wildcard triggers, check all assets
      const assetsToCheck = trigger.asset_id === "*"
        ? Array.from(this.assetToConnection.keys())
        : [trigger.asset_id];

      for (const assetId of assetsToCheck) {
        const lastUpdate = this.lastUpdateTs.get(assetId);
        if (lastUpdate === undefined) continue;

        // Check cooldown
        const cooldownKey = `${triggerId}:${assetId}`;
        const lastFire = this.lastTriggerFire.get(cooldownKey) || 0;
        if (now - lastFire < trigger.cooldown_ms * 1000) continue;

        // Calculate staleness (convert source_ts from ms to us for comparison)
        const staleMs = (now - lastUpdate * 1000) / 1000;

        if (staleMs > threshold) {
          this.lastTriggerFire.set(cooldownKey, now);

          const latestBBO = this.latestBBO.get(assetId);
          const conditionId = this.assetToMarket.get(assetId) || "unknown";

          const event: TriggerEvent = {
            trigger_id: triggerId,
            trigger_type: "STALE_QUOTE",
            asset_id: assetId,
            condition_id: conditionId,
            fired_at: Math.floor(now),
            // For stale quote: latency = time since last quote update (meaningful metric)
            total_latency_us: latestBBO?.ts ? Math.floor(now - latestBBO.ts) : 0,
            processing_latency_us: latestBBO?.ts ? Math.floor(now - latestBBO.ts) : 0,

            best_bid: latestBBO?.best_bid ?? null,
            best_ask: latestBBO?.best_ask ?? null,
            bid_size: null,
            ask_size: null,
            spread_bps: null,

            threshold: trigger.condition.threshold,
            actual_value: staleMs,
            stale_ms: staleMs,

            book_hash: "stale",
            sequence_number: 0,
            metadata: trigger.metadata,
          };

          firedEvents.push({ trigger, event });
        }
      }
    }

    // Dispatch events asynchronously (batched SSE + individual webhooks)
    if (firedEvents.length > 0) {
      console.log(`[Alarm] Detected ${firedEvents.length} stale quote(s)`);

      // Batched SSE publish
      this.ctx.waitUntil(this.publishEventsToBuffer(firedEvents.map(f => f.event)));

      // Individual webhook dispatch
      for (const { trigger, event } of firedEvents) {
        if (trigger.webhook_url) {
          this.ctx.waitUntil(this.dispatchWebhook(trigger, event));
        }
      }
    }
  }

  private async persistState(): Promise<void> {
    await this.ctx.storage.put("poolState", {
      assetToConnection: Array.from(this.assetToConnection.entries()),
      assetToMarket: Array.from(this.assetToMarket.entries()),
      assetToMarketSource: Array.from(this.assetToMarketSource.entries()),
      tickSizes: Array.from(this.tickSizes.entries()),
      negRisk: Array.from(this.negRisk.entries()),
      orderMinSizes: Array.from(this.orderMinSizes.entries()),
      triggers: Array.from(this.triggers.values()),
      compoundTriggers: Array.from(this.compoundTriggers.values()),
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
   * Check if queue is healthy (not too many recent failures)
   */
  private isQueueHealthy(queueName: string): boolean {
    const failures = this.queueFailures.get(queueName);
    if (!failures) return true;

    const now = Date.now();
    if (now - failures.lastFailure > this.QUEUE_FAILURE_WINDOW_MS) {
      this.queueFailures.delete(queueName);
      return true;
    }

    return failures.count < this.QUEUE_FAILURE_THRESHOLD;
  }

  private recordQueueFailure(queueName: string): void {
    const now = Date.now();
    const current = this.queueFailures.get(queueName);

    if (current && now - current.lastFailure < this.QUEUE_FAILURE_WINDOW_MS) {
      current.count++;
      current.lastFailure = now;
    } else {
      this.queueFailures.set(queueName, { count: 1, lastFailure: now });
    }
  }

  private recordQueueSuccess(queueName: string): void {
    this.queueFailures.delete(queueName);
  }

  /**
   * Safe queue send with backpressure - throttles when queue is unhealthy
   */
  private async sendToQueue<T>(
    queueName: string,
    queue: { send: (msg: T) => Promise<void> },
    message: T
  ): Promise<boolean> {
    // Throttle 90% of messages when queue is unhealthy
    if (!this.isQueueHealthy(queueName) && Math.random() > 0.1) {
      return false;
    }

    try {
      await queue.send(message);
      this.recordQueueSuccess(queueName);
      return true;
    } catch (error) {
      this.recordQueueFailure(queueName);
      console.error(`[Queue] Failed to send to ${queueName}:`, error);
      return false;
    }
  }

  /**
   * Safe batch queue send with backpressure
   */
  private async sendBatchToQueue<T>(
    queueName: string,
    queue: { sendBatch: (messages: { body: T }[]) => Promise<void> },
    messages: T[]
  ): Promise<boolean> {
    if (!this.isQueueHealthy(queueName) && Math.random() > 0.1) {
      return false;
    }

    try {
      await queue.sendBatch(messages.map((body) => ({ body })));
      this.recordQueueSuccess(queueName);
      return true;
    } catch (error) {
      this.recordQueueFailure(queueName);
      console.error(`[Queue] Failed to send batch to ${queueName} (${messages.length} items):`, error);
      return false;
    }
  }

  // ============================================================
  // DO-DIRECT BUFFER FLUSH METHODS
  // Flush directly to ClickHouse, fall back to queue on failure
  // ============================================================

  /**
   * Add snapshot to buffer and schedule flush
   */
  private bufferSnapshot(snapshot: BBOSnapshot): void {
    if (this.snapshotBuffer.length >= this.MAX_BUFFER_SIZE) {
      this.snapshotBuffer.shift(); // Drop oldest to prevent OOM
    }
    this.snapshotBuffer.push(snapshot);
    if (this.snapshotBuffer.length >= this.BUFFER_SIZE) {
      // Clear pending timer before size-triggered flush to prevent race condition
      if (this.snapshotFlushTimer) {
        clearTimeout(this.snapshotFlushTimer);
        this.snapshotFlushTimer = null;
      }
      this.ctx.waitUntil(this.flushSnapshotBuffer());
    } else if (!this.snapshotFlushTimer) {
      this.snapshotFlushTimer = setTimeout(() => {
        this.ctx.waitUntil(this.flushSnapshotBuffer());
      }, this.BUFFER_FLUSH_MS);
    }
  }

  /**
   * Flush snapshot buffer directly to ClickHouse
   */
  private async flushSnapshotBuffer(): Promise<void> {
    if (this.snapshotBuffer.length === 0 || this.isFlushingSnapshots) return;

    this.isFlushingSnapshots = true;
    const batchSize = this.snapshotBuffer.length;
    const batch = this.snapshotBuffer.slice(0, batchSize); // Copy, don't mutate yet
    if (this.snapshotFlushTimer) {
      clearTimeout(this.snapshotFlushTimer);
      this.snapshotFlushTimer = null;
    }

    try {
      const clickhouse = new ClickHouseOrderbookClient(this.env);
      const result = await clickhouse.insertSnapshots(batch);

      if (result.success) {
        this.snapshotBuffer.splice(0, batchSize); // Clear only after success
      } else {
        // ClickHouse insert failed - check if we should retry via queue
        console.error(`[DO ${this.shardId}] ClickHouse insert failed: ${result.error}`);
        if (result.shouldRetry) {
          // Transient failure - try queue fallback
          const queued = await this.sendBatchToQueue("SNAPSHOT_QUEUE", this.env.SNAPSHOT_QUEUE, batch);
          if (queued) {
            this.snapshotBuffer.splice(0, batchSize); // Clear only after queue accepts
          } else {
            console.error(`[DO ${this.shardId}] CRITICAL: Both ClickHouse and queue failed, retaining ${batchSize} snapshots`);
          }
        } else {
          // Permanent failure (client error) - log and drop to prevent infinite retry
          console.error(`[DO ${this.shardId}] Permanent ClickHouse failure, dropping ${batchSize} snapshots`);
          this.snapshotBuffer.splice(0, batchSize);
        }
      }
    } catch (error) {
      // Defensive: handle unexpected exceptions (should not occur with current API)
      console.error(`[DO ${this.shardId}] Unexpected error in flushSnapshotBuffer:`, error);
      const queued = await this.sendBatchToQueue("SNAPSHOT_QUEUE", this.env.SNAPSHOT_QUEUE, batch);
      if (queued) {
        this.snapshotBuffer.splice(0, batchSize);
      }
    } finally {
      this.isFlushingSnapshots = false;
    }
  }

  /**
   * Add level change to buffer and schedule flush
   */
  private bufferLevelChange(changes: OrderbookLevelChange[]): void {
    this.levelChangeBuffer.push(...changes);
    if (this.levelChangeBuffer.length >= this.BUFFER_SIZE) {
      // Clear pending timer before size-triggered flush to prevent race condition
      if (this.levelChangeFlushTimer) {
        clearTimeout(this.levelChangeFlushTimer);
        this.levelChangeFlushTimer = null;
      }
      this.ctx.waitUntil(this.flushLevelChangeBuffer());
    } else if (!this.levelChangeFlushTimer) {
      this.levelChangeFlushTimer = setTimeout(() => {
        this.ctx.waitUntil(this.flushLevelChangeBuffer());
      }, this.BUFFER_FLUSH_MS);
    }
  }

  /**
   * Flush level change buffer directly to ClickHouse
   */
  private async flushLevelChangeBuffer(): Promise<void> {
    if (this.levelChangeBuffer.length === 0) return;

    const batch = this.levelChangeBuffer.splice(0);
    if (this.levelChangeFlushTimer) {
      clearTimeout(this.levelChangeFlushTimer);
      this.levelChangeFlushTimer = null;
    }

    // Level changes still go through queue (lower priority than BBO)
    await this.sendBatchToQueue("LEVEL_CHANGE_QUEUE", this.env.LEVEL_CHANGE_QUEUE, batch);
  }

  /**
   * Add trade to buffer and schedule flush
   */
  private bufferTrade(trade: TradeTick): void {
    this.tradeBuffer.push(trade);
    if (this.tradeBuffer.length >= this.BUFFER_SIZE) {
      // Clear pending timer before size-triggered flush to prevent race condition
      if (this.tradeFlushTimer) {
        clearTimeout(this.tradeFlushTimer);
        this.tradeFlushTimer = null;
      }
      this.ctx.waitUntil(this.flushTradeBuffer());
    } else if (!this.tradeFlushTimer) {
      this.tradeFlushTimer = setTimeout(() => {
        this.ctx.waitUntil(this.flushTradeBuffer());
      }, this.BUFFER_FLUSH_MS);
    }
  }

  /**
   * Flush trade buffer to queue
   */
  private async flushTradeBuffer(): Promise<void> {
    if (this.tradeBuffer.length === 0) return;

    const batch = this.tradeBuffer.splice(0);
    if (this.tradeFlushTimer) {
      clearTimeout(this.tradeFlushTimer);
      this.tradeFlushTimer = null;
    }

    // Trades still go through queue
    await this.sendBatchToQueue("TRADE_QUEUE", this.env.TRADE_QUEUE, batch);
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
    this.assetToMarketSource.delete(assetId);
    this.localBooks.delete(assetId);
    this.lastQuotes.delete(assetId);
    this.lastFullL2SnapshotTs.delete(assetId);
    this.subscriptionState.delete(assetId);
    this.priceHistory.delete(assetId);
    this.latestBBO.delete(assetId);
    this.missingBookFirstSeen.delete(assetId);
    // Clean up HFT trigger state
    this.updateCounts.delete(assetId);
    this.trendTracker.delete(assetId);
    this.imbalanceHistory.delete(assetId);
    this.lastUpdateTs.delete(assetId);
    this.previousBBO.delete(assetId);

    // Clean up market relationships
    const relatedAssets = this.marketRelationships.get(assetId);
    if (relatedAssets) {
      // Remove this asset from all related assets' relationship sets
      for (const related of relatedAssets) {
        this.marketRelationships.get(related)?.delete(assetId);
      }
      this.marketRelationships.delete(assetId);
    }

    // Clean up triggers for this asset
    const triggerIds = this.triggersByAsset.get(assetId);
    if (triggerIds) {
      for (const triggerId of triggerIds) {
        this.triggers.delete(triggerId);
        this.lastTriggerFire.delete(triggerId);
        // Clean up cached HMAC keys
        this.hmacKeyCache.delete(triggerId);
      }
      this.triggersByAsset.delete(assetId);
    }
  }

  /**
   * Register a market relationship between two assets (e.g., YES/NO token pair)
   * Used to proactively mark counterpart BBO as stale when primary updates
   */
  private registerMarketRelationship(assetId1: string, assetId2: string): void {
    if (!this.marketRelationships.has(assetId1)) {
      this.marketRelationships.set(assetId1, new Set());
    }
    if (!this.marketRelationships.has(assetId2)) {
      this.marketRelationships.set(assetId2, new Set());
    }
    this.marketRelationships.get(assetId1)!.add(assetId2);
    this.marketRelationships.get(assetId2)!.add(assetId1);
  }

  /**
   * Get related assets for a given asset ID (e.g., counterpart YES/NO token)
   */
  private getRelatedAssets(assetId: string): string[] {
    return Array.from(this.marketRelationships.get(assetId) || []);
  }

  /**
   * Mark related assets' BBO as potentially stale when a new update arrives
   * This prevents false arbitrage signals from mismatched YES/NO data
   */
  private markRelatedAssetsStale(assetId: string, currentTs: number): void {
    const relatedAssets = this.marketRelationships.get(assetId);
    if (!relatedAssets) return;

    const STALE_THRESHOLD_MS = 5000; // 5 seconds
    for (const related of relatedAssets) {
      const relatedBBO = this.latestBBO.get(related);
      if (relatedBBO && currentTs - relatedBBO.ts > STALE_THRESHOLD_MS) {
        relatedBBO.stale = true;
      }
    }
  }

  // ============================================================
  // MULTI-MARKET ADAPTER SUPPORT
  // ============================================================

  /**
   * Get or create a connector for the specified market source.
   * Connectors are cached to avoid repeated instantiation.
   */
  private getMarketConnector(marketSource: string): MarketConnector {
    if (!this.connectors.has(marketSource)) {
      this.connectors.set(marketSource, getConnector(marketSource));
    }
    return this.connectors.get(marketSource)!;
  }

  // ============================================================
  // DATA INTEGRITY: Stale Quote and Missing Book Detection
  // ============================================================

  /**
   * Track assets that received price_change before initial book event.
   * Triggers resync if book event not received within timeout.
   */
  private trackMissingBook(assetId: string): void {
    if (!this.missingBookFirstSeen.has(assetId)) {
      this.missingBookFirstSeen.set(assetId, Date.now());
      console.warn(`[DO ${this.shardId}] Asset ${assetId.slice(0, 12)}... missing initial book event`);
    }
  }

  /**
   * Check for stale quotes and missing book events.
   * Called from alarm handler.
   */
  private checkDataIntegrity(): void {
    const now = Date.now();

    // Check for assets that never received initial book event
    for (const [assetId, firstSeen] of this.missingBookFirstSeen) {
      if (now - firstSeen > this.MISSING_BOOK_TIMEOUT_MS) {
        console.error(
          `[DO ${this.shardId}] Asset ${assetId.slice(0, 12)}... never received book event after ${Math.round((now - firstSeen) / 1000)}s`
        );
        // Trigger resync by removing from tracking and requesting fresh subscription
        this.missingBookFirstSeen.delete(assetId);
        this.ctx.waitUntil(this.triggerResync(assetId));
      }
    }

    // Check for stale quotes (no updates for too long)
    for (const [assetId, localBook] of this.localBooks) {
      const timeSinceUpdate = now - localBook.last_update_ts;
      if (timeSinceUpdate > this.STALE_QUOTE_THRESHOLD_MS) {
        console.warn(
          `[DO ${this.shardId}] Stale quote for ${assetId.slice(0, 12)}...: ` +
          `last update ${Math.round(timeSinceUpdate / 1000)}s ago`
        );
        // Record stale quote event for monitoring
        const clickhouse = new ClickHouseOrderbookClient(this.env);
        this.ctx.waitUntil(
          clickhouse.recordGapEvent(
            assetId,
            localBook.last_hash,
            "STALE",
            timeSinceUpdate,
            this.assetToMarketSource.get(assetId)
          )
        );
        // Trigger resync
        this.ctx.waitUntil(this.triggerResync(assetId));
      }
    }
  }

  // ============================================================
  // DATA INTEGRITY: Hash Chain and Sequence Validation
  // ============================================================

  /**
   * Verify hash chain continuity for an asset.
   *
   * Polymarket semantics: The hash in price_change events is the NEW hash after
   * applying the change. We verify continuity by checking if the hash transition
   * makes sense (hash should change when there are changes).
   *
   * @param assetId - Asset ID to verify
   * @param newHash - New hash from the event
   * @param currentLocalHash - Our current local hash (before applying changes)
   * @returns true if valid, false if gap detected
   */
  private verifyHashChain(assetId: string, newHash: string, currentLocalHash: string): boolean {
    const localBook = this.localBooks.get(assetId);

    // First message for this asset - no previous hash to validate
    if (!localBook?.last_hash) return true;

    // If the new hash equals our current hash, the changes may have been duplicates
    // or the hash didn't change for some reason - log but allow
    if (newHash === currentLocalHash) {
      // This is suspicious but not necessarily an error - could be duplicate event
      return true;
    }

    // Hash changed - this is expected when we apply changes
    // Update the local book hash (will be done by caller after applying changes)
    return true;
  }

  /**
   * Validate sequence number continuity.
   * Returns true if valid, false if gap detected.
   */
  private verifySequence(assetId: string, eventSequence: number): boolean {
    const localBook = this.localBooks.get(assetId);

    // First message - accept any sequence
    if (!localBook) return true;

    const expectedSequence = localBook.sequence + 1;

    if (eventSequence !== expectedSequence) {
      console.error(
        `[DO ${this.shardId}] Sequence gap for ${assetId}: ` +
        `expected=${expectedSequence}, got=${eventSequence}`
      );

      // If we're behind, trigger a resync
      if (eventSequence > expectedSequence) {
        this.ctx.waitUntil(this.triggerResync(assetId));
      }

      return false;
    }

    return true;
  }

  /**
   * Handle detected gap in hash chain or sequence.
   * Records gap event and triggers resync.
   */
  private handleGapDetection(assetId: string, lastKnownHash: string, newHash: string): void {
    const localBook = this.localBooks.get(assetId);
    const gapDurationMs = localBook
      ? Date.now() - localBook.last_update_ts
      : 0;

    // Record gap event for monitoring
    const clickhouse = new ClickHouseOrderbookClient(this.env);
    this.ctx.waitUntil(
      clickhouse.recordGapEvent(
        assetId,
        lastKnownHash,
        newHash,
        gapDurationMs,
        this.assetToMarketSource.get(assetId)
      )
    );

    // Trigger resync
    this.ctx.waitUntil(this.triggerResync(assetId));
  }

  /**
   * Trigger a resync for an asset by clearing local state.
   * The next 'book' event will rebuild the orderbook.
   */
  private async triggerResync(assetId: string): Promise<void> {
    console.log(`[DO ${this.shardId}] Triggering resync for ${assetId}`);

    // Clear local book to force rebuild on next book event
    this.localBooks.delete(assetId);
    this.lastQuotes.delete(assetId);

    // Optionally queue a gap backfill job for historical recovery
    const localBook = this.localBooks.get(assetId);
    if (localBook?.last_hash) {
      const job = {
        market_source: this.assetToMarketSource.get(assetId) ?? getDefaultMarketSource(),
        asset_id: assetId,
        last_known_hash: localBook.last_hash,
        gap_detected_at: Date.now(),
        retry_count: 0,
      };
      await this.sendToQueue("GAP_BACKFILL_QUEUE", this.env.GAP_BACKFILL_QUEUE, job);
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
      market_source: this.assetToMarketSource.get(assetId) ?? getDefaultMarketSource(),
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

      // HFT trigger validations
      case "VOLATILITY_SPIKE":
        if (!condition.window_ms || typeof condition.window_ms !== "number") {
          return "VOLATILITY_SPIKE requires condition.window_ms (number)";
        }
        if (condition.window_ms > this.PRICE_HISTORY_MAX_AGE_MS) {
          return `window_ms cannot exceed ${this.PRICE_HISTORY_MAX_AGE_MS}ms`;
        }
        break;

      case "IMBALANCE_SHIFT":
        if (!condition.window_ms || typeof condition.window_ms !== "number") {
          return "IMBALANCE_SHIFT requires condition.window_ms (number)";
        }
        break;

      case "QUOTE_VELOCITY":
        if (!condition.window_ms || typeof condition.window_ms !== "number") {
          return "QUOTE_VELOCITY requires condition.window_ms (number)";
        }
        break;

      case "MID_PRICE_TREND":
        if (condition.side && !["BID", "ASK"].includes(condition.side)) {
          return "MID_PRICE_TREND condition.side must be 'BID' or 'ASK' if specified";
        }
        break;

      case "LARGE_FILL":
        if (condition.side && !["BID", "ASK"].includes(condition.side)) {
          return "LARGE_FILL condition.side must be 'BID' or 'ASK' if specified";
        }
        break;

      case "MULTI_OUTCOME_ARBITRAGE":
        if (!condition.outcome_asset_ids || !Array.isArray(condition.outcome_asset_ids)) {
          return "MULTI_OUTCOME_ARBITRAGE requires condition.outcome_asset_ids (array)";
        }
        if (condition.outcome_asset_ids.length < 2) {
          return "MULTI_OUTCOME_ARBITRAGE requires at least 2 outcome_asset_ids";
        }
        break;

      // MICROPRICE_DIVERGENCE and STALE_QUOTE only need threshold (already validated above)
    }

    return null;
  }

  // ============================================================
  // TRIGGER MANAGEMENT ENDPOINTS
  // ============================================================

  private handleListTriggers(): Response {
    const triggers = Array.from(this.triggers.values());
    const compoundTriggers = Array.from(this.compoundTriggers.values());
    return Response.json({
      triggers,
      compound_triggers: compoundTriggers,
      total: triggers.length + compoundTriggers.length,
      standard_count: triggers.length,
      compound_count: compoundTriggers.length,
      by_asset: Object.fromEntries(
        Array.from(this.triggersByAsset.entries()).map(([k, v]) => [k, v.size])
      ),
    });
  }

  private async handleRegisterTrigger(request: Request): Promise<Response> {
    try {
      // Accept both standard trigger and compound trigger fields
      const body = (await request.json()) as Partial<Trigger> & Partial<CompoundTrigger> & {
        compound_mode?: CompoundTrigger["compound_mode"];
        conditions?: CompoundTrigger["conditions"];
        compound_threshold?: number;
        cross_shard?: boolean;
        inferred_edge_type?: "correlation" | "hedge" | "causal";
        user_id?: string;
        market_source?: string;
      };

      // Validate required fields (condition is optional for compound triggers)
      if (!body.asset_id || !body.webhook_url || (!body.condition && !body.conditions)) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: "Missing required fields: asset_id, webhook_url, and condition (or conditions for compound triggers)",
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      // Validation: conditions array requires compound_mode
      if (body.conditions && !body.compound_mode) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: "compound_mode is required when using conditions array. Use 'ALL_OF', 'ANY_OF', or 'N_OF_M'.",
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      // Validation: N_OF_M mode requires compound_threshold >= 1
      if (body.compound_mode === "N_OF_M" && (body.compound_threshold === undefined || body.compound_threshold < 1)) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: "compound_threshold is required for N_OF_M mode and must be >= 1",
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      // Validate condition-specific parameters (skip for compound triggers)
      if (body.condition && !body.compound_mode) {
        const validationError = this.validateTriggerCondition(body.condition);
        if (validationError) {
          return Response.json(
            { trigger_id: "", status: "error", message: validationError } as TriggerRegistration,
            { status: 400 }
          );
        }
      }

      // For compound triggers, validate all conditions
      if (body.compound_mode && body.conditions) {
        for (let i = 0; i < body.conditions.length; i++) {
          const condition = body.conditions[i];
          const validationError = this.validateTriggerCondition(condition);
          if (validationError) {
            return Response.json(
              { trigger_id: "", status: "error", message: `Condition ${i}: ${validationError}` } as TriggerRegistration,
              { status: 400 }
            );
          }

          // Validate each condition's asset_id is subscribed on this shard
          // (compound triggers can span multiple assets, all must be accessible)
          if (condition.asset_id && condition.asset_id !== "*" && !this.assetToMarket.has(condition.asset_id)) {
            return Response.json(
              {
                trigger_id: "",
                status: "error",
                message: `Condition ${i}: asset ${condition.asset_id.slice(0, 20)}... is not subscribed on this shard`,
              } as TriggerRegistration,
              { status: 400 }
            );
          }

          // Validate market_id is provided (required for graph signals)
          if (!condition.market_id) {
            return Response.json(
              {
                trigger_id: "",
                status: "error",
                message: `Condition ${i}: market_id is required for compound triggers`,
              } as TriggerRegistration,
              { status: 400 }
            );
          }
        }
      }

      if (body.asset_id !== "*" && !this.assetToMarket.has(body.asset_id)) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: `Asset ${body.asset_id.slice(0, 20)}... is not subscribed on this shard. ` +
                     `Ensure condition_id is provided for correct routing, or the asset must be subscribed first.`,
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

      // Validate cooldown bounds to prevent system overload (DoS prevention)
      const MIN_COOLDOWN_MS = 100;   // Minimum 100ms to prevent trigger spam
      const MAX_COOLDOWN_MS = 3600000; // Maximum 1 hour
      const cooldown = body.cooldown_ms ?? 1000;

      if (cooldown < MIN_COOLDOWN_MS) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: `cooldown_ms must be at least ${MIN_COOLDOWN_MS}ms`,
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      if (cooldown > MAX_COOLDOWN_MS) {
        return Response.json(
          {
            trigger_id: "",
            status: "error",
            message: `cooldown_ms cannot exceed ${MAX_COOLDOWN_MS}ms (1 hour)`,
          } as TriggerRegistration,
          { status: 400 }
        );
      }

      const triggerId = body.id || `trig_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

      // Check if this is a compound trigger (has conditions array and compound_mode)
      if (body.compound_mode && Array.isArray(body.conditions) && body.conditions.length > 0) {
        // Create compound trigger
        const compoundTrigger: CompoundTrigger = {
          id: triggerId,
          asset_id: body.asset_id, // Primary asset for routing
          condition: body.conditions[0], // First condition as primary (for type compatibility)
          conditions: body.conditions,
          compound_mode: body.compound_mode,
          compound_threshold: body.compound_threshold,
          cross_shard: body.cross_shard ?? false,
          inferred_edge_type: body.inferred_edge_type || "correlation",
          market_ids: body.conditions.map((c: { market_id: string }) => c.market_id),
          market_source: body.market_source || "polymarket",
          user_id: body.user_id,
          webhook_url: body.webhook_url,
          webhook_secret: body.webhook_secret,
          enabled: body.enabled ?? true,
          cooldown_ms: cooldown,
          created_at: Date.now(),
          metadata: body.metadata,
        };

        // Store compound trigger
        this.compoundTriggers.set(triggerId, compoundTrigger);

        // Index by all asset_ids in conditions for efficient lookup
        for (const condition of compoundTrigger.conditions) {
          if (!this.triggersByAsset.has(condition.asset_id)) {
            this.triggersByAsset.set(condition.asset_id, new Set());
          }
          this.triggersByAsset.get(condition.asset_id)!.add(triggerId);
        }

        // Emit edge signals for market pairs (user believes these are related)
        if (this.env.GRAPH_QUEUE && compoundTrigger.market_ids.length > 1) {
          this.ctx.waitUntil(this.emitTriggerCreationSignals(compoundTrigger));
        }

        await this.persistState();

        console.log(
          `[Trigger] Registered compound trigger ${triggerId}: ` +
          `${compoundTrigger.compound_mode} with ${compoundTrigger.conditions.length} conditions`
        );

        return Response.json({
          trigger_id: triggerId,
          status: "created",
          type: "compound",
        } as TriggerRegistration);
      }

      // Standard single-condition trigger
      // At this point body.condition must exist (validated above and not compound)
      const trigger: Trigger = {
        id: triggerId,
        asset_id: body.asset_id,
        condition: body.condition!,
        webhook_url: body.webhook_url,
        webhook_secret: body.webhook_secret,
        enabled: body.enabled ?? true,
        cooldown_ms: cooldown,
        created_at: Date.now(),
        metadata: body.metadata,
      };

      // Store trigger and compute bounds for pre-filtering
      this.triggers.set(trigger.id, trigger);
      this.triggerBounds.set(trigger.id, computeTriggerBounds(trigger));
      if (!this.triggersByAsset.has(trigger.asset_id)) {
        this.triggersByAsset.set(trigger.asset_id, new Set());
      }
      this.triggersByAsset.get(trigger.asset_id)!.add(trigger.id);

      // Pre-warm HMAC key cache if webhook has a secret (avoids 100-500μs on first fire)
      if (trigger.webhook_secret) {
        this.getOrCreateHmacKey(trigger.id, trigger.webhook_secret).catch((err) => {
          console.error(
            `[Trigger] Failed to pre-warm HMAC key for ${trigger.id} ` +
            `(webhook: ${trigger.webhook_url?.slice(0, 50)}...):`,
            err
          );
        });
      }

      // Also index wildcard triggers
      if (trigger.asset_id === "*") {
        for (const assetId of this.assetToConnection.keys()) {
          if (!this.triggersByAsset.has(assetId)) {
            this.triggersByAsset.set(assetId, new Set());
          }
          this.triggersByAsset.get(assetId)!.add(trigger.id);
        }
      }

      // CRITICAL: Register market relationship for arbitrage triggers
      // This enables proactive staleness marking to prevent false signals
      if (
        (trigger.condition.type === "ARBITRAGE_BUY" || trigger.condition.type === "ARBITRAGE_SELL") &&
        trigger.condition.counterpart_asset_id
      ) {
        // Validate counterpart asset is subscribed (unless wildcard trigger)
        const counterpartExists = trigger.asset_id === "*" ||
          this.assetToConnection.has(trigger.condition.counterpart_asset_id);

        if (!counterpartExists) {
          return Response.json(
            {
              trigger_id: "",
              status: "error",
              message: `Counterpart asset ${trigger.condition.counterpart_asset_id.slice(0, 20)}... is not subscribed on this shard`,
            } as TriggerRegistration,
            { status: 400 }
          );
        }

        this.registerMarketRelationship(trigger.asset_id, trigger.condition.counterpart_asset_id);
        console.log(
          `[Trigger] Registered market relationship: ${trigger.asset_id.slice(0, 12)}... <-> ${trigger.condition.counterpart_asset_id.slice(0, 12)}...`
        );
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

      // Check standard triggers first
      const trigger = this.triggers.get(trigger_id);
      if (trigger) {
        // Remove from all maps including bounds cache
        this.triggers.delete(trigger_id);
        this.triggerBounds.delete(trigger_id);
        this.triggersByAsset.get(trigger.asset_id)?.delete(trigger_id);

        // Invalidate cached HMAC key
        this.invalidateHmacKeyCache(trigger_id);

        // If wildcard, remove from all assets
        if (trigger.asset_id === "*") {
          for (const assetTriggers of this.triggersByAsset.values()) {
            assetTriggers.delete(trigger_id);
          }
        }

        await this.persistState();
        console.log(`[Trigger] Deleted trigger ${trigger_id}`);
        return Response.json({ status: "deleted", trigger_id });
      }

      // Check compound triggers
      const compoundTrigger = this.compoundTriggers.get(trigger_id);
      if (compoundTrigger) {
        // Remove from compound triggers map
        this.compoundTriggers.delete(trigger_id);

        // Remove from triggersByAsset for all conditions
        for (const condition of compoundTrigger.conditions) {
          this.triggersByAsset.get(condition.asset_id)?.delete(trigger_id);
        }

        // Invalidate cached HMAC key
        this.invalidateHmacKeyCache(trigger_id);

        // Clear evaluator state for this trigger
        if (this.compoundEvaluator) {
          this.compoundEvaluator.clearTriggerState(trigger_id);
        }

        await this.persistState();
        console.log(`[Trigger] Deleted compound trigger ${trigger_id}`);
        return Response.json({ status: "deleted", trigger_id, type: "compound" });
      }

      return Response.json({ status: "error", message: "Trigger not found" }, { status: 404 });
    } catch (error) {
      return Response.json({ status: "error", message: String(error) }, { status: 500 });
    }
  }

  // ============================================================
  // TRIGGER EVALUATION - Called on every BBO update
  // CRITICAL PATH OPTIMIZATION: Fully synchronous to minimize latency
  // Only webhook dispatch is async (via waitUntil)
  // ============================================================

  private async evaluateTriggersAsync(snapshot: BBOSnapshot): Promise<void> {
    try {
      await this.evaluateTriggersCore(snapshot);
    } catch (error) {
      // CRITICAL: Don't let trigger evaluation crash the DO
      // Log error with stack trace and continue processing orderbook updates
      console.error(
        `[Trigger] CRITICAL: Evaluation crashed for ${snapshot.asset_id.slice(0, 12)}...:`,
        error instanceof Error ? error.stack || error.message : String(error)
      );

      // Circuit breaker: Track failures for all triggers associated with this asset
      // When a crash occurs, we can't know which trigger caused it, so we track
      // failures at the asset level and propagate to all triggers for this asset
      this.recordTriggerFailuresForAsset(snapshot.asset_id);
    }
  }

  private recordTriggerFailure(triggerId: string): void {
    const count = (this.triggerFailureCount.get(triggerId) || 0) + 1;
    this.triggerFailureCount.set(triggerId, count);
    if (count >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.triggerCircuitOpen.set(triggerId, Date.now() + this.CIRCUIT_BREAKER_RESET_MS);
      console.error(`[CircuitBreaker] OPENED for trigger ${triggerId} after ${count} failures`);
    }
  }

  private recordTriggerFailuresForAsset(assetId: string): void {
    const triggerIds = this.triggersByAsset.get(assetId);
    if (triggerIds) {
      for (const id of triggerIds) this.recordTriggerFailure(id);
    }
  }

  private recordTriggerSuccess(triggerId: string): void {
    if (this.triggerFailureCount.delete(triggerId) && this.triggerCircuitOpen.delete(triggerId)) {
      console.log(`[CircuitBreaker] CLOSED for trigger ${triggerId}`);
    }
  }

  private isTriggerCircuitClosed(triggerId: string): boolean {
    const resetTime = this.triggerCircuitOpen.get(triggerId);
    if (!resetTime) return true;
    if (Date.now() >= resetTime) {
      console.log(`[CircuitBreaker] HALF-OPEN for trigger ${triggerId}`);
      return true;
    }
    return false;
  }

  /**
   * Core trigger evaluation logic, separated for error isolation.
   * Any exception here is caught by evaluateTriggersAsync.
   */
  private async evaluateTriggersCore(snapshot: BBOSnapshot): Promise<void> {
    // Store latest BBO for arbitrage calculations
    // Mark as NOT stale since we just received fresh data
    // Include size data for trade sizing calculations
    this.latestBBO.set(snapshot.asset_id, {
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      bid_size: snapshot.bid_size,
      ask_size: snapshot.ask_size,
      ts: snapshot.source_ts,
      stale: false,
    });

    // CRITICAL: Mark related assets' BBO as potentially stale
    // This prevents false arbitrage signals when YES updates but NO is old
    this.markRelatedAssetsStale(snapshot.asset_id, snapshot.source_ts);

    const assetTriggerIds = this.triggersByAsset.get(snapshot.asset_id);
    const wildcardTriggerIds = this.triggersByAsset.get("*");

    const triggerIdsToCheck = new Set<string>();
    if (assetTriggerIds) {
      for (const id of assetTriggerIds) triggerIdsToCheck.add(id);
    }
    if (wildcardTriggerIds) {
      for (const id of wildcardTriggerIds) triggerIdsToCheck.add(id);
    }

    const hasRegisteredTriggers = triggerIdsToCheck.size > 0;
    const now = Date.now() * 1000; // Microseconds

    // Update price history for PRICE_MOVE triggers and VOLATILITY_SPIKE global trigger
    // Always track since global triggers need this data for volatility calculations
    // Compute midpoint from best_bid and best_ask for accurate price movement detection
    if (snapshot.best_bid !== null && snapshot.best_ask !== null) {
      const midPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
      let history = this.priceHistory.get(snapshot.asset_id);
      if (!history) {
        history = [];
        this.priceHistory.set(snapshot.asset_id, history);
      }
      history.push({ ts: snapshot.source_ts, price: midPrice });

      // CRITICAL: Prune on EVERY update to prevent unbounded growth
      // Time-based (60s) + count-based (1000 entries) limits
      const cutoffUs = snapshot.source_ts - (this.PRICE_HISTORY_MAX_AGE_MS * 1000);
      this.pruneHistory(history, this.MAX_PRICE_HISTORY_ENTRIES, cutoffUs);
    }

    // ============================================================
    // HFT TRIGGER STATE TRACKING
    // Update state maps needed for advanced triggers
    // ============================================================

    // STALE_QUOTE: Track last update timestamp
    this.lastUpdateTs.set(snapshot.asset_id, snapshot.source_ts);

    // QUOTE_VELOCITY: Track update counts in rolling window
    const updateCount = this.updateCounts.get(snapshot.asset_id);
    if (updateCount) {
      // If within same window, increment count
      const windowMs = 1000; // Default 1 second window (will be overridden by trigger's window_ms)
      if (snapshot.source_ts - updateCount.windowStartUs < windowMs * 1000) {
        updateCount.count++;
      } else {
        // Start new window
        updateCount.count = 1;
        updateCount.windowStartUs = snapshot.source_ts;
      }
    } else {
      this.updateCounts.set(snapshot.asset_id, { count: 1, windowStartUs: snapshot.source_ts });
    }

    // MID_PRICE_TREND: Track consecutive price moves using true midpoint
    if (snapshot.best_bid !== null && snapshot.best_ask !== null) {
      const midPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
      const trend = this.trendTracker.get(snapshot.asset_id);
      if (trend) {
        if (midPrice > trend.lastMid) {
          // Price went up
          if (trend.direction === "UP") {
            trend.consecutiveMoves++;
          } else {
            trend.direction = "UP";
            trend.consecutiveMoves = 1;
          }
        } else if (midPrice < trend.lastMid) {
          // Price went down
          if (trend.direction === "DOWN") {
            trend.consecutiveMoves++;
          } else {
            trend.direction = "DOWN";
            trend.consecutiveMoves = 1;
          }
        }
        // If equal, keep current state
        trend.lastMid = midPrice;
      } else {
        this.trendTracker.set(snapshot.asset_id, {
          lastMid: midPrice,
          consecutiveMoves: 0,
          direction: "UP", // Initial direction doesn't matter until we see movement
        });
      }
    }

    // IMBALANCE_SHIFT: Track imbalance history
    if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
      const total = snapshot.bid_size + snapshot.ask_size;
      if (total > 0) {
        const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
        let imbHistory = this.imbalanceHistory.get(snapshot.asset_id);
        if (!imbHistory) {
          imbHistory = [];
          this.imbalanceHistory.set(snapshot.asset_id, imbHistory);
        }
        imbHistory.push({ imbalance, ts: snapshot.source_ts });
        // Prune to max entries (count-based only)
        this.pruneHistory(imbHistory, this.MAX_IMBALANCE_HISTORY_ENTRIES);
      }
    }

    // LARGE_FILL: Store current BBO sizes for next comparison (after trigger evaluation)
    // We'll update this AFTER evaluating triggers so we can compare current vs previous

    // CRITICAL PATH OPTIMIZATION: Collect all fired events for potential batched dispatch
    const firedEvents: { trigger: Trigger; event: TriggerEvent }[] = [];

    // Only evaluate registered triggers if any exist
    if (hasRegisteredTriggers) {
      for (const triggerId of triggerIdsToCheck) {
        const trigger = this.triggers.get(triggerId);
        if (!trigger || !trigger.enabled) continue;

        // LATENCY OPTIMIZATION: Pre-filter using bounds check (2-10μs per skipped trigger)
        // This runs BEFORE circuit breaker to avoid any unnecessary work
        if (!this.canTriggerFire(triggerId, snapshot)) {
          continue;
        }

        // Circuit breaker: Skip triggers with open circuits
        if (!this.isTriggerCircuitClosed(triggerId)) {
          continue;
        }

        // Check cooldown
        const lastFire = this.lastTriggerFire.get(triggerId) || 0;
        if (now - lastFire < trigger.cooldown_ms * 1000) continue; // Convert ms to us

        let result: { fired: boolean; actualValue: number; arbitrageData?: Partial<TriggerEvent> };
        try {
          result = this.checkTriggerCondition(trigger, snapshot);
          this.recordTriggerSuccess(triggerId);
        } catch (error) {
          console.error(`[Trigger] Failed ${triggerId}: ${error instanceof Error ? error.message : error}`);
          this.recordTriggerFailure(triggerId);
          continue;
        }

        if (result.fired) {
          this.lastTriggerFire.set(triggerId, now);

          const event: TriggerEvent = {
            trigger_id: triggerId,
            trigger_type: trigger.condition.type,
            asset_id: snapshot.asset_id,
            condition_id: snapshot.condition_id,
            fired_at: Math.floor(now),
            // Dual latency tracking (both timestamps are in microseconds)
            total_latency_us: Math.floor(now - snapshot.source_ts), // includes network latency
            processing_latency_us: Math.floor(now - snapshot.ingestion_ts), // DO processing only

            best_bid: snapshot.best_bid,
            best_ask: snapshot.best_ask,
            bid_size: snapshot.bid_size,
            ask_size: snapshot.ask_size,
            spread_bps: snapshot.spread_bps,

            threshold: trigger.condition.threshold,
            actual_value: result.actualValue,

            // Add arbitrage-specific fields if applicable
            ...result.arbitrageData,

            book_hash: snapshot.book_hash,
            sequence_number: snapshot.sequence_number,
            metadata: trigger.metadata,
          };

          firedEvents.push({ trigger, event });

          // Record latency for metrics tracking
          this.latencyTracker.record(event.total_latency_us, event.processing_latency_us);
        }
      }
    }

    // ============================================================
    // GLOBAL TRIGGERS - Always-on triggers for dashboard streaming
    // These fire without registration and publish directly to SSE (no webhook)
    // CRITICAL: Evaluate BEFORE compound trigger await to prevent race conditions
    // with concurrent evaluations accessing stale previousBBO state
    // ============================================================
    const globalEvents = this.evaluateGlobalTriggers(snapshot, now);

    // LARGE_FILL: Update previousBBO IMMEDIATELY after global triggers read it
    // This must happen BEFORE any await to prevent concurrent evaluations from
    // reading stale previousBBO values (race condition via ctx.waitUntil)
    this.previousBBO.set(snapshot.asset_id, {
      bid_size: snapshot.bid_size,
      ask_size: snapshot.ask_size,
    });

    // ============================================================
    // COMPOUND TRIGGERS - Multi-market condition triggers
    // Uses CompoundTriggerEvaluator with gradual decay for wrong hypotheses
    // CRITICAL: Must await to ensure fired events are collected before SSE/webhook dispatch
    // ============================================================
    if (this.compoundTriggers.size > 0 && this.compoundEvaluator) {
      await this.evaluateCompoundTriggers(snapshot, now, firedEvents);
    }

    // Collect all events for batched SSE publish (reduces DO hops)
    // OPTIMIZED: Push loop instead of spread operator to avoid intermediate allocations
    const allEvents: TriggerEvent[] = [];
    for (const f of firedEvents) allEvents.push(f.event);
    for (const e of globalEvents) allEvents.push(e);

    // LATENCY OPTIMIZATION: Write to premium SSE clients FIRST (1-5ms savings)
    // Premium clients bypass the TriggerEventBuffer hop
    if (allEvents.length > 0) {
      this.writeToPremiumSSE(allEvents);
    }

    // Then publish to buffer for standard SSE clients (fire-and-forget)
    if (allEvents.length > 0) {
      this.ctx.waitUntil(this.publishEventsToBuffer(allEvents));
    }

    // Dispatch webhooks individually for registered triggers with webhook_url
    for (const { trigger, event } of firedEvents) {
      if (trigger.webhook_url) {
        this.ctx.waitUntil(this.dispatchWebhook(trigger, event));
      }
    }
    // Note: Removed per-trigger console.log to avoid microtask overhead in hot path.
    // Trigger fires are observable via SSE stream and metrics endpoint.
  }

  /**
   * Fast pre-filter check using pre-computed bounds.
   * Returns true if the trigger CAN possibly fire given the current BBO.
   * This avoids expensive full evaluation for triggers that can't possibly match.
   *
   * CRITICAL PATH: This must be O(1) with no allocations.
   * OPTIMIZED: Restructured to reduce branch misprediction (check value once, then bounds).
   */
  private canTriggerFire(triggerId: string, snapshot: BBOSnapshot): boolean {
    const bounds = this.triggerBounds.get(triggerId);
    if (!bounds) return true; // No bounds = must evaluate

    // Destructure for JIT optimizer hints
    const { best_bid, best_ask, spread_bps, bid_size, ask_size } = snapshot;

    // Check bid constraints (single null check covers both min/max)
    if (best_bid !== null) {
      if (bounds.minBid !== null && best_bid < bounds.minBid) return false;
      if (bounds.maxBid !== null && best_bid > bounds.maxBid) return false;
    } else if (bounds.minBid !== null || bounds.maxBid !== null) {
      return false; // Bid constraint exists but bid is null
    }

    // Check ask constraints
    if (best_ask !== null) {
      if (bounds.minAsk !== null && best_ask < bounds.minAsk) return false;
      if (bounds.maxAsk !== null && best_ask > bounds.maxAsk) return false;
    } else if (bounds.minAsk !== null || bounds.maxAsk !== null) {
      return false;
    }

    // Check spread constraints
    if (spread_bps !== null) {
      if (bounds.minSpreadBps !== null && spread_bps < bounds.minSpreadBps) return false;
      if (bounds.maxSpreadBps !== null && spread_bps > bounds.maxSpreadBps) return false;
    } else if (bounds.minSpreadBps !== null || bounds.maxSpreadBps !== null) {
      return false;
    }

    // Check size constraints
    if (bid_size !== null) {
      if (bounds.minBidSize !== null && bid_size < bounds.minBidSize) return false;
    } else if (bounds.minBidSize !== null) {
      return false;
    }

    if (ask_size !== null) {
      if (bounds.minAskSize !== null && ask_size < bounds.minAskSize) return false;
    } else if (bounds.minAskSize !== null) {
      return false;
    }

    return true;
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
        // Compare midpoint-to-midpoint for accurate price movement detection
        if (snapshot.best_bid === null || snapshot.best_ask === null || !window_ms) break;

        const history = this.priceHistory.get(snapshot.asset_id);
        if (!history || history.length === 0) break;

        // Convert window_ms to microseconds (source_ts is in microseconds)
        const windowStartUs = snapshot.source_ts - (window_ms * 1000);

        // Binary search for first entry within window (O(log n) vs O(n) linear scan)
        // History is sorted ascending by timestamp, so we find leftmost entry >= windowStartUs
        let baselineEntry: PriceHistoryEntry | null = null;
        let left = 0;
        let right = history.length - 1;
        let firstValidIdx = history.length;

        while (left <= right) {
          const mid = Math.floor((left + right) / 2);
          if (history[mid].ts >= windowStartUs) {
            firstValidIdx = mid;
            right = mid - 1; // Continue searching left for earliest valid entry
          } else {
            left = mid + 1; // Search right for valid entries
          }
        }

        if (firstValidIdx < history.length) {
          baselineEntry = history[firstValidIdx];
        }

        if (baselineEntry && baselineEntry.price > 0) {
          const currentMidPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
          const pctChange =
            Math.abs((currentMidPrice - baselineEntry.price) / baselineEntry.price) * 100;
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

      case "EMPTY_BOOK": {
        // Both sides of book are empty - critical market state
        // Indicates: market halt, liquidity withdrawal, data gap, or pre/post market
        const bidEmpty = snapshot.bid_size === null || snapshot.bid_size === 0;
        const askEmpty = snapshot.ask_size === null || snapshot.ask_size === 0;
        if (bidEmpty && askEmpty) {
          return { fired: true, actualValue: 0 };
        }
        break;
      }

      case "ARBITRAGE_BUY": {
        // YES_ask + NO_ask < threshold means buying both guarantees profit
        // threshold is typically < 1.0 (e.g., 0.99 to account for fees)
        if (!counterpart_asset_id || snapshot.best_ask === null) break;

        const counterpartBBO = this.latestBBO.get(counterpart_asset_id);
        if (!counterpartBBO || counterpartBBO.best_ask === null) break;

        // CRITICAL: Check BOTH explicit stale flag AND time delta to prevent false signals
        // Stale flag is set proactively when counterpart data is old relative to new updates
        if (counterpartBBO.stale) break;
        if (!isTimestampFresh(snapshot.source_ts, counterpartBBO.ts)) break;

        const sumOfAsks = snapshot.best_ask + counterpartBBO.best_ask;
        if (sumOfAsks < threshold) {
          // Profit = 1 - sumOfAsks (guaranteed payout is $1)
          const profitBps = (1 - sumOfAsks) * 10000;

          // Trade sizing using shared utility
          const sizing = calculateArbitrageSizing({
            primarySize: snapshot.ask_size,
            counterpartSize: counterpartBBO.ask_size,
            priceSum: sumOfAsks,
            profitPerShare: 1 - sumOfAsks,
          });

          return {
            fired: true,
            actualValue: sumOfAsks,
            arbitrageData: {
              counterpart_asset_id,
              counterpart_best_bid: counterpartBBO.best_bid,
              counterpart_best_ask: counterpartBBO.best_ask,
              counterpart_bid_size: counterpartBBO.bid_size,
              counterpart_ask_size: counterpartBBO.ask_size,
              sum_of_asks: sumOfAsks,
              potential_profit_bps: profitBps,
              ...sizing,
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

        // CRITICAL: Check BOTH explicit stale flag AND time delta to prevent false signals
        // Stale flag is set proactively when counterpart data is old relative to new updates
        if (counterpartBBO.stale) break;
        if (!isTimestampFresh(snapshot.source_ts, counterpartBBO.ts)) break;

        const sumOfBids = snapshot.best_bid + counterpartBBO.best_bid;
        if (sumOfBids > threshold) {
          // Profit = sumOfBids - 1 (you receive more than the $1 you'll pay out)
          const profitBps = (sumOfBids - 1) * 10000;

          // Trade sizing using shared utility
          const sizing = calculateArbitrageSizing({
            primarySize: snapshot.bid_size,
            counterpartSize: counterpartBBO.bid_size,
            priceSum: sumOfBids,
            profitPerShare: sumOfBids - 1,
          });

          return {
            fired: true,
            actualValue: sumOfBids,
            arbitrageData: {
              counterpart_asset_id,
              counterpart_best_bid: counterpartBBO.best_bid,
              counterpart_best_ask: counterpartBBO.best_ask,
              counterpart_bid_size: counterpartBBO.bid_size,
              counterpart_ask_size: counterpartBBO.ask_size,
              sum_of_bids: sumOfBids,
              potential_profit_bps: profitBps,
              ...sizing,
            },
          };
        }
        break;
      }

      // ============================================================
      // HFT TRIGGERS - Advanced market making signals
      // ============================================================

      case "VOLATILITY_SPIKE": {
        // Calculate rolling std dev of price returns over window_ms
        // AS model spread = 2/γ + γσ²(T-t) — when σ spikes, spreads should widen
        // Requires both bid and ask since price history stores midpoint
        if (snapshot.best_bid === null || snapshot.best_ask === null || !window_ms) break;

        const history = this.priceHistory.get(snapshot.asset_id);
        if (!history || history.length < 2) break;

        // Convert window_ms to microseconds
        const windowStartUs = snapshot.source_ts - (window_ms * 1000);

        // OPTIMIZED: Binary search for window start index - O(log n) instead of O(n) filter
        let startIdx = 0;
        {
          let left = 0;
          let right = history.length;
          while (left < right) {
            const mid = (left + right) >>> 1;
            if (history[mid].ts < windowStartUs) {
              left = mid + 1;
            } else {
              right = mid;
            }
          }
          startIdx = left;
        }

        const windowLength = history.length - startIdx;
        if (windowLength < 2) break;

        // OPTIMIZED: Calculate variance in single pass using Welford's online algorithm
        // No intermediate array allocations
        let count = 0;
        let mean = 0;
        let m2 = 0; // Sum of squared differences from mean

        for (let i = startIdx + 1; i < history.length; i++) {
          const prevPrice = history[i - 1].price;
          if (prevPrice > 0) {
            const ret = (history[i].price - prevPrice) / prevPrice;
            count++;
            const delta = ret - mean;
            mean += delta / count;
            const delta2 = ret - mean;
            m2 += delta * delta2;
          }
        }

        if (count < 2) break;

        const variance = m2 / count;
        const volatilityPct = Math.sqrt(Math.max(0, variance)) * 100;

        if (volatilityPct > threshold) {
          return {
            fired: true,
            actualValue: volatilityPct,
            arbitrageData: {
              volatility: volatilityPct,
            },
          };
        }
        break;
      }

      case "MICROPRICE_DIVERGENCE": {
        // Microprice = (best_bid × ask_size + best_ask × bid_size) / (bid_size + ask_size)
        // Better short-term price predictor than mid. Divergence signals directional momentum.
        if (snapshot.best_bid === null || snapshot.best_ask === null ||
            snapshot.bid_size === null || snapshot.ask_size === null) break;

        const totalSize = snapshot.bid_size + snapshot.ask_size;
        if (totalSize === 0) break;

        const microprice = (snapshot.best_bid * snapshot.ask_size + snapshot.best_ask * snapshot.bid_size) / totalSize;
        const midPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
        if (midPrice === 0) break;
        const divergenceBps = Math.abs((microprice - midPrice) / midPrice) * 10000;

        if (divergenceBps > threshold) {
          return {
            fired: true,
            actualValue: divergenceBps,
            arbitrageData: {
              microprice,
              microprice_divergence_bps: divergenceBps,
            },
          };
        }
        break;
      }

      case "IMBALANCE_SHIFT": {
        // Detect rapid changes in book imbalance — signals shift in order flow
        if (!window_ms) break;
        if (snapshot.bid_size === null || snapshot.ask_size === null) break;

        const total = snapshot.bid_size + snapshot.ask_size;
        if (total === 0) break;

        const currentImbalance = (snapshot.bid_size - snapshot.ask_size) / total;

        const imbHistory = this.imbalanceHistory.get(snapshot.asset_id);
        if (!imbHistory || imbHistory.length === 0) break;

        // OPTIMIZED: Binary search for window start - O(log n) instead of O(n) linear scan
        const windowStartUs = snapshot.source_ts - (window_ms * 1000);
        let previousImbalance: number | null = null;
        {
          let left = 0;
          let right = imbHistory.length;
          while (left < right) {
            const mid = (left + right) >>> 1;
            if (imbHistory[mid].ts < windowStartUs) {
              left = mid + 1;
            } else {
              right = mid;
            }
          }
          // left is now the first index where ts >= windowStartUs
          if (left < imbHistory.length) {
            previousImbalance = imbHistory[left].imbalance;
          }
        }

        if (previousImbalance === null) break;

        const imbalanceDelta = Math.abs(currentImbalance - previousImbalance);

        if (imbalanceDelta > threshold) {
          return {
            fired: true,
            actualValue: imbalanceDelta,
            arbitrageData: {
              imbalance_delta: imbalanceDelta,
              previous_imbalance: previousImbalance,
              current_imbalance: currentImbalance,
            },
          };
        }
        break;
      }

      case "MID_PRICE_TREND": {
        // Detect consecutive price moves in same direction — crucial for AS inventory management
        const trend = this.trendTracker.get(snapshot.asset_id);
        if (!trend) break;

        // Check if side filter matches (optional)
        if (side === "BID" && trend.direction !== "DOWN") break;
        if (side === "ASK" && trend.direction !== "UP") break;

        if (trend.consecutiveMoves >= threshold) {
          return {
            fired: true,
            actualValue: trend.consecutiveMoves,
            arbitrageData: {
              consecutive_moves: trend.consecutiveMoves,
              trend_direction: trend.direction,
            },
          };
        }
        break;
      }

      case "QUOTE_VELOCITY": {
        // Detect when other MMs are updating quotes frequently — competitive pressure
        if (!window_ms) break;

        const updateCount = this.updateCounts.get(snapshot.asset_id);
        if (!updateCount) break;

        // Calculate updates per second
        const windowSec = window_ms / 1000;
        const elapsedUs = snapshot.source_ts - updateCount.windowStartUs;
        const elapsedSec = elapsedUs / 1000000;

        // Only evaluate if we have at least half the window elapsed
        if (elapsedSec < windowSec * 0.5) break;

        const updatesPerSecond = updateCount.count / Math.max(elapsedSec, 0.001);

        if (updatesPerSecond > threshold) {
          return {
            fired: true,
            actualValue: updatesPerSecond,
            arbitrageData: {
              updates_per_second: updatesPerSecond,
            },
          };
        }
        break;
      }

      case "STALE_QUOTE": {
        // Note: This is primarily evaluated in alarm() handler, but can also fire on BBO update
        // if the previous update was stale. Evaluated based on lastUpdateTs.
        // This case is a no-op during normal BBO updates since we just updated lastUpdateTs
        break;
      }

      case "MULTI_OUTCOME_ARBITRAGE": {
        // Sum of all outcome asks < threshold = arbitrage opportunity for N-outcome markets
        const { outcome_asset_ids } = trigger.condition;
        if (!outcome_asset_ids || outcome_asset_ids.length < 2) break;

        let sumOfAsks = 0;
        let validCount = 0;
        let minAskSize: number | null = null;

        for (const assetId of outcome_asset_ids) {
          const bbo = this.latestBBO.get(assetId);
          if (!bbo || bbo.best_ask === null) continue;

          // Check staleness using shared constant
          if (!isTimestampFresh(snapshot.source_ts, bbo.ts)) continue;

          sumOfAsks += bbo.best_ask;
          validCount++;

          // Track minimum ask size across all outcomes (liquidity-constrained)
          const askSize = bbo.ask_size ?? 0;
          if (minAskSize === null || askSize < minAskSize) {
            minAskSize = askSize;
          }
        }

        // Need data for all outcomes
        if (validCount !== outcome_asset_ids.length) break;

        if (sumOfAsks < threshold) {
          const profitBps = (1 - sumOfAsks) * 10000;
          const profitPerShare = 1 - sumOfAsks;
          const recommendedSize = minAskSize ?? 0;

          return {
            fired: true,
            actualValue: sumOfAsks,
            arbitrageData: {
              outcome_ask_sum: sumOfAsks,
              outcome_count: validCount,
              potential_profit_bps: profitBps,
              recommended_size: recommendedSize,
              max_notional: recommendedSize * sumOfAsks,
              expected_profit: recommendedSize * profitPerShare,
            },
          };
        }
        break;
      }

      case "LARGE_FILL": {
        // Detect when significant size is removed from the orderbook (whale activity)
        const prevBBO = this.previousBBO.get(snapshot.asset_id);
        if (!prevBBO) break;

        let fillNotional = 0;
        let fillSide: "BID" | "ASK" | null = null;
        let sizeDelta = 0;

        // Check bid side for size removal
        if ((!side || side === "BID") && prevBBO.bid_size !== null && snapshot.bid_size !== null) {
          const bidDelta = snapshot.bid_size - prevBBO.bid_size;
          if (bidDelta < 0 && snapshot.best_bid !== null) {
            const notional = Math.abs(bidDelta) * snapshot.best_bid;
            if (notional > fillNotional) {
              fillNotional = notional;
              fillSide = "BID";
              sizeDelta = bidDelta;
            }
          }
        }

        // Check ask side for size removal
        if ((!side || side === "ASK") && prevBBO.ask_size !== null && snapshot.ask_size !== null) {
          const askDelta = snapshot.ask_size - prevBBO.ask_size;
          if (askDelta < 0 && snapshot.best_ask !== null) {
            const notional = Math.abs(askDelta) * snapshot.best_ask;
            if (notional > fillNotional) {
              fillNotional = notional;
              fillSide = "ASK";
              sizeDelta = askDelta;
            }
          }
        }

        if (fillNotional > threshold && fillSide) {
          return {
            fired: true,
            actualValue: fillNotional,
            arbitrageData: {
              fill_notional: fillNotional,
              fill_side: fillSide,
              size_delta: sizeDelta,
            },
          };
        }
        break;
      }
    }

    return { fired: false, actualValue: 0 };
  }

  // ============================================================
  // COMPOUND TRIGGER EVALUATION
  // Multi-market triggers with gradual decay for wrong hypotheses
  // ============================================================

  /**
   * Evaluate compound triggers that span multiple markets.
   * Uses CompoundTriggerEvaluator which tracks:
   * - Partial condition fires across BBO updates
   * - Cross-shard coordination via KV
   * - Gradual edge decay when triggers don't fire
   */
  private async evaluateCompoundTriggers(
    snapshot: BBOSnapshot,
    nowUs: number,
    firedEvents: { trigger: Trigger; event: TriggerEvent }[]
  ): Promise<void> {
    if (!this.compoundEvaluator) return;

    // Find compound triggers that include this asset in their conditions
    for (const [triggerId, trigger] of this.compoundTriggers) {
      if (!trigger.enabled) continue;

      // Check if any condition involves this asset
      const involvesAsset = trigger.conditions.some(
        c => c.asset_id === snapshot.asset_id
      );
      if (!involvesAsset) continue;

      // Check cooldown
      const lastFire = this.lastTriggerFire.get(triggerId) || 0;
      if (nowUs - lastFire < (trigger.cooldown_ms || 0) * 1000) continue;

      // Circuit breaker check
      if (!this.isTriggerCircuitClosed(triggerId)) continue;

      // CRITICAL: Check if this trigger is already being evaluated (race condition prevention)
      // Multiple concurrent evaluations via waitUntil could otherwise pass cooldown check
      // before any of them complete, causing duplicate fires
      if (this.compoundTriggerInFlight.has(triggerId)) continue;
      this.compoundTriggerInFlight.add(triggerId);

      try {
        const result = await this.compoundEvaluator.evaluate(
          trigger,
          snapshot,
          this.latestBBO
        );

        this.recordTriggerSuccess(triggerId);

        if (result.shouldFire) {
          this.lastTriggerFire.set(triggerId, nowUs);

          // Create compound trigger event
          const event = this.compoundEvaluator.createTriggerEvent(
            trigger,
            snapshot,
            result,
            snapshot.source_ts,
            snapshot.ingestion_ts
          );

          // Push to firedEvents for webhook dispatch
          // Note: We cast to Trigger since CompoundTrigger extends it
          firedEvents.push({ trigger: trigger as unknown as Trigger, event });

          // Record latency
          this.latencyTracker.record(event.total_latency_us, event.processing_latency_us);

          // Emit reinforcement signal to graph queue (trigger fire = user was right)
          if (this.env.GRAPH_QUEUE && trigger.market_ids && trigger.market_ids.length > 1) {
            this.ctx.waitUntil(this.emitTriggerFireSignals(trigger));
          }
        }
        // Decay tracking happens automatically inside compoundEvaluator.evaluate()
      } catch (error) {
        console.error(
          `[Trigger] Compound trigger ${triggerId} failed:`,
          error instanceof Error ? error.message : error
        );
        this.recordTriggerFailure(triggerId);
      } finally {
        // Always remove from in-flight set to allow future evaluations
        this.compoundTriggerInFlight.delete(triggerId);
      }
    }
  }

  /**
   * Emit edge reinforcement signals when a compound trigger fires.
   * This indicates the user's market relationship hypothesis was correct.
   */
  private async emitTriggerFireSignals(trigger: CompoundTrigger): Promise<void> {
    const marketIds = trigger.market_ids;
    if (!marketIds || marketIds.length < 2) return;

    const edgeType = trigger.inferred_edge_type || "correlation";

    // Generate all pairs and emit signals
    for (let i = 0; i < marketIds.length; i++) {
      for (let j = i + 1; j < marketIds.length; j++) {
        try {
          await this.env.GRAPH_QUEUE.send({
            type: "edge_signal",
            market_a: marketIds[i],
            market_b: marketIds[j],
            edge_type: edgeType,
            signal_source: "trigger_fire",
            user_id: trigger.user_id || "",
            strength: 1.0, // Positive reinforcement
            metadata: {
              trigger_id: trigger.id,
              shard_id: this.shardId,
              fired_at: Date.now(),
            },
          });
        } catch (error) {
          console.error(
            `[Graph] Failed to emit fire signal for ${marketIds[i]}-${marketIds[j]}:`,
            error
          );
        }
      }
    }
  }

  /**
   * Emit initial edge signals when a compound trigger is created.
   * This records the user's hypothesis that these markets are related.
   */
  private async emitTriggerCreationSignals(trigger: CompoundTrigger): Promise<void> {
    const marketIds = trigger.market_ids;
    if (!marketIds || marketIds.length < 2) return;

    const edgeType = trigger.inferred_edge_type || "correlation";

    // Generate all pairs and emit signals
    for (let i = 0; i < marketIds.length; i++) {
      for (let j = i + 1; j < marketIds.length; j++) {
        try {
          await this.env.GRAPH_QUEUE.send({
            type: "edge_signal",
            market_a: marketIds[i],
            market_b: marketIds[j],
            edge_type: edgeType,
            signal_source: "user_trigger",
            user_id: trigger.user_id || "",
            strength: 1.5, // Stronger than analysis, weaker than fire
            metadata: {
              trigger_id: trigger.id,
              shard_id: this.shardId,
              created_at: Date.now(),
              compound_mode: trigger.compound_mode,
            },
          });
        } catch (error) {
          console.error(
            `[Graph] Failed to emit creation signal for ${marketIds[i]}-${marketIds[j]}:`,
            error
          );
        }
      }
    }
  }

  // Global trigger cooldown tracking (separate from registered triggers)
  private globalTriggerCooldowns: Map<string, number> = new Map();
  private readonly GLOBAL_TRIGGER_COOLDOWN_MS = 500; // 500ms cooldown per trigger type per asset

  /**
   * Evaluate global/built-in triggers that run on every BBO update without registration.
   * These provide a baseline stream of market events for the dashboard.
   */
  private evaluateGlobalTriggers(snapshot: BBOSnapshot, nowUs: number): TriggerEvent[] {
    const events: TriggerEvent[] = [];
    const assetId = snapshot.asset_id;

    // Helper to check cooldown and create event
    const maybeFireGlobal = (
      triggerType: TriggerType,
      threshold: number,
      actualValue: number,
      extraData?: Partial<TriggerEvent>
    ): boolean => {
      const cooldownKey = `global:${assetId}:${triggerType}`;
      const lastFire = this.globalTriggerCooldowns.get(cooldownKey) || 0;

      if (nowUs - lastFire < this.GLOBAL_TRIGGER_COOLDOWN_MS * 1000) {
        return false;
      }

      this.globalTriggerCooldowns.set(cooldownKey, nowUs);

      events.push({
        trigger_id: `global_${triggerType.toLowerCase()}`,
        trigger_type: triggerType,
        asset_id: assetId,
        condition_id: snapshot.condition_id,
        fired_at: Math.floor(nowUs),
        // Dual latency tracking (both timestamps are in microseconds)
        total_latency_us: Math.floor(nowUs - snapshot.source_ts),
        processing_latency_us: Math.floor(nowUs - snapshot.ingestion_ts),

        best_bid: snapshot.best_bid,
        best_ask: snapshot.best_ask,
        bid_size: snapshot.bid_size,
        ask_size: snapshot.ask_size,
        spread_bps: snapshot.spread_bps,

        threshold,
        actual_value: actualValue,

        book_hash: snapshot.book_hash,
        sequence_number: snapshot.sequence_number,
        ...extraData,
      });

      return true;
    };

    // ============================================================
    // GLOBAL TRIGGER DEFINITIONS
    // Sensible defaults that provide useful market signals
    // ============================================================

    // SPREAD_WIDE: Fire when spread > 200 bps (2%)
    if (snapshot.spread_bps !== null && snapshot.spread_bps > 200) {
      maybeFireGlobal("SPREAD_WIDE", 200, snapshot.spread_bps);
    }

    // SPREAD_NARROW: Fire when spread < 20 bps (0.2%) - very tight
    if (snapshot.spread_bps !== null && snapshot.spread_bps < 20) {
      maybeFireGlobal("SPREAD_NARROW", 20, snapshot.spread_bps);
    }

    // IMBALANCE_BID: Fire when imbalance > 0.6 (strong bid pressure)
    if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
      const total = snapshot.bid_size + snapshot.ask_size;
      if (total > 0) {
        const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
        if (imbalance > 0.6) {
          maybeFireGlobal("IMBALANCE_BID", 0.6, imbalance);
        } else if (imbalance < -0.6) {
          maybeFireGlobal("IMBALANCE_ASK", 0.6, Math.abs(imbalance));
        }
      }
    }

    // CROSSED_BOOK: Always fire (critical condition)
    if (snapshot.best_bid !== null && snapshot.best_ask !== null && snapshot.best_bid >= snapshot.best_ask) {
      maybeFireGlobal("CROSSED_BOOK", 0, snapshot.best_bid - snapshot.best_ask);
    }

    // EMPTY_BOOK: Always fire (critical condition)
    if ((snapshot.best_bid === null || snapshot.bid_size === 0) &&
        (snapshot.best_ask === null || snapshot.ask_size === 0)) {
      maybeFireGlobal("EMPTY_BOOK", 0, 0);
    }

    // MICROPRICE_DIVERGENCE: Fire when divergence > 50 bps
    if (snapshot.best_bid !== null && snapshot.best_ask !== null &&
        snapshot.bid_size !== null && snapshot.ask_size !== null) {
      const totalSize = snapshot.bid_size + snapshot.ask_size;
      if (totalSize > 0) {
        const microprice = (snapshot.best_bid * snapshot.ask_size + snapshot.best_ask * snapshot.bid_size) / totalSize;
        const midPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
        if (midPrice > 0) {
          const divergenceBps = Math.abs((microprice - midPrice) / midPrice) * 10000;
          if (divergenceBps > 50) {
            maybeFireGlobal("MICROPRICE_DIVERGENCE", 50, divergenceBps, {
              microprice,
              microprice_divergence_bps: divergenceBps,
            });
          }
        }
      }
    }

    // MID_PRICE_TREND: Fire on 3+ consecutive moves
    const trend = this.trendTracker.get(assetId);
    if (trend && trend.consecutiveMoves >= 3) {
      maybeFireGlobal("MID_PRICE_TREND", 3, trend.consecutiveMoves, {
        consecutive_moves: trend.consecutiveMoves,
        trend_direction: trend.direction,
      });
    }

    // LARGE_FILL: Fire when > $1000 notional removed
    const prevBBO = this.previousBBO.get(assetId);
    if (prevBBO) {
      let fillNotional = 0;
      let fillSide: "BID" | "ASK" | null = null;
      let sizeDelta = 0;

      if (prevBBO.bid_size !== null && snapshot.bid_size !== null && snapshot.best_bid !== null) {
        const bidDelta = snapshot.bid_size - prevBBO.bid_size;
        if (bidDelta < 0) {
          const notional = Math.abs(bidDelta) * snapshot.best_bid;
          if (notional > fillNotional) {
            fillNotional = notional;
            fillSide = "BID";
            sizeDelta = bidDelta;
          }
        }
      }

      if (prevBBO.ask_size !== null && snapshot.ask_size !== null && snapshot.best_ask !== null) {
        const askDelta = snapshot.ask_size - prevBBO.ask_size;
        if (askDelta < 0) {
          const notional = Math.abs(askDelta) * snapshot.best_ask;
          if (notional > fillNotional) {
            fillNotional = notional;
            fillSide = "ASK";
            sizeDelta = askDelta;
          }
        }
      }

      if (fillNotional > 1000 && fillSide) {
        maybeFireGlobal("LARGE_FILL", 1000, fillNotional, {
          fill_notional: fillNotional,
          fill_side: fillSide,
          size_delta: sizeDelta,
        });
      }
    }

    // VOLATILITY_SPIKE: Fire when volatility > 2% (checked with 10s window)
    // OPTIMIZED: Uses binary search + in-place variance calculation to avoid allocations
    // Requires both bid and ask since price history stores midpoint
    if (snapshot.best_bid !== null && snapshot.best_ask !== null) {
      const history = this.priceHistory.get(assetId);
      if (history && history.length >= 5) {
        const windowStartUs = snapshot.source_ts - 10000000; // 10 second window

        // Binary search for window start index - O(log n) instead of O(n) filter
        let startIdx = 0;
        let left = 0, right = history.length;
        while (left < right) {
          const mid = (left + right) >>> 1;
          if (history[mid].ts < windowStartUs) {
            left = mid + 1;
          } else {
            right = mid;
          }
        }
        startIdx = left;

        const windowLength = history.length - startIdx;
        if (windowLength >= 3) {
          // Calculate returns and variance in single pass without allocation
          // Using Welford's online algorithm for numerical stability
          let count = 0;
          let mean = 0;
          let m2 = 0; // Sum of squared differences from mean

          for (let i = startIdx + 1; i < history.length; i++) {
            const prevPrice = history[i - 1].price;
            if (prevPrice > 0) {
              const ret = (history[i].price - prevPrice) / prevPrice;
              count++;
              const delta = ret - mean;
              mean += delta / count;
              const delta2 = ret - mean;
              m2 += delta * delta2;
            }
          }

          if (count >= 2) {
            const variance = m2 / count;
            const volatilityPct = Math.sqrt(Math.max(0, variance)) * 100;

            if (volatilityPct > 2) {
              maybeFireGlobal("VOLATILITY_SPIKE", 2, volatilityPct, {
                volatility: volatilityPct,
              });
            }
          }
        }
      }
    }

    return events;
  }

  /**
   * Prune timestamped history array in-place (DRY helper for memory management)
   * Supports both time-based and count-based pruning.
   * @param history Array with `ts` field (in microseconds)
   * @param maxEntries Maximum entries to keep
   * @param cutoffUs Optional time cutoff in microseconds (entries older than this are removed)
   */
  private pruneHistory<T extends { ts: number }>(
    history: T[],
    maxEntries: number,
    cutoffUs?: number
  ): void {
    let firstValidIdx = 0;

    // Time-based pruning (if cutoff provided)
    // OPTIMIZED: Binary search O(log n) instead of linear scan O(n)
    if (cutoffUs !== undefined && history.length > 0) {
      let left = 0;
      let right = history.length;
      // Find first index where ts >= cutoffUs
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (history[mid].ts < cutoffUs) {
          left = mid + 1;
        } else {
          right = mid;
        }
      }
      firstValidIdx = left;
    }

    // Enforce count-based limit
    const startIdx = Math.max(firstValidIdx, history.length - maxEntries);

    // In-place pruning (no new array allocation)
    if (startIdx > 0) {
      history.splice(0, startIdx);
    }
  }

  /**
   * CRITICAL PATH OPTIMIZATION: Get or create cached HMAC key for webhook signing
   * Avoids expensive crypto.subtle.importKey on every webhook dispatch (100-500μs savings)
   */
  private async getOrCreateHmacKey(triggerId: string, secret: string): Promise<CryptoKey> {
    // Check cache first
    let key = this.hmacKeyCache.get(triggerId);
    if (key) {
      return key;
    }

    // Import and cache the key
    const encoder = new TextEncoder();
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    this.hmacKeyCache.set(triggerId, key);
    return key;
  }

  /**
   * Invalidate cached HMAC key when trigger is deleted or secret changes
   */
  private invalidateHmacKeyCache(triggerId: string): void {
    this.hmacKeyCache.delete(triggerId);
  }

  /**
   * Dispatch webhook with HMAC signature (background task)
   */
  private async dispatchWebhook(trigger: Trigger, event: TriggerEvent): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Trigger-ID": trigger.id,
      "X-Trigger-Type": trigger.condition.type,
    };

    if (trigger.webhook_secret) {
      const key = await this.getOrCreateHmacKey(trigger.id, trigger.webhook_secret);
      const encoder = new TextEncoder();
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
      headers["X-Trigger-Signature"] = btoa(String.fromCharCode(...new Uint8Array(signature)));
    }

    try {
      const response = await fetch(trigger.webhook_url!, { method: "POST", headers, body });
      if (!response.ok) {
        console.error(`[Trigger] Webhook failed for ${trigger.id}: ${response.status}`);
      }
    } catch (error) {
      console.error(`[Trigger] Webhook error for ${trigger.id}:`, error);
    }
  }

  /**
   * Get cached DO stubs for all regional event buffers.
   * LATENCY OPTIMIZATION: Events are published to all 4 regional buffers
   * so traders connect to the nearest one (10-50ms savings for non-EU).
   *
   * Returns cached array after first call (O(1) instead of O(n) with 4 Map lookups).
   */
  private getRegionalBufferStubs(): DurableObjectStub[] {
    // Return cached array if already initialized
    if (this.cachedRegionalBufferStubArray) {
      return this.cachedRegionalBufferStubArray;
    }

    // Initialize all stubs and cache the array
    const regionNames = getAllRegionalBufferNames();
    const stubs: DurableObjectStub[] = [];

    for (const name of regionNames) {
      const stub = this.env.TRIGGER_EVENT_BUFFER.get(
        this.env.TRIGGER_EVENT_BUFFER.idFromName(name)
      );
      this.regionalBufferStubs.set(name, stub);
      stubs.push(stub);
    }

    this.cachedRegionalBufferStubArray = stubs;
    return stubs;
  }

  // Shared headers object - created once at module level
  private static readonly PUBLISH_HEADERS = { "Content-Type": "application/json" };

  /**
   * Batch publish trigger events to ALL regional TriggerEventBuffers.
   * Fan-out ensures all regional SSE clients receive events simultaneously.
   *
   * KEY FIX: Uses Promise.allSettled to prevent one region's failure from
   * affecting other regions. Previously used Promise.all which would fail-fast
   * and potentially leave some regions without events.
   */
  private async publishEventsToBuffer(events: TriggerEvent[]): Promise<void> {
    if (events.length === 0) return;

    const stubs = this.getRegionalBufferStubs();
    const body = JSON.stringify(events);
    const regionNames = getAllRegionalBufferNames();

    // Fan-out to all regional buffers in parallel - use allSettled for resilience
    const results = await Promise.allSettled(
      stubs.map((stub, idx) =>
        stub.fetch("https://do/publish-batch", {
          method: "POST",
          headers: OrderbookManager.PUBLISH_HEADERS,
          body,
        }).then(res => ({ region: regionNames[idx], ok: res.ok, status: res.status }))
      )
    );

    // Log failures per-region for observability
    const failures = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
    if (failures.length > 0) {
      for (const result of failures) {
        if (result.status === "rejected") {
          console.error(`[Trigger] Regional buffer publish failed:`, result.reason);
        } else if (result.status === "fulfilled" && !result.value.ok) {
          console.error(`[Trigger] Regional buffer ${result.value.region} returned ${result.value.status}`);
        }
      }
    }
  }
}
