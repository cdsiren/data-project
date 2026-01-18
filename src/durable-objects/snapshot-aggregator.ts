// src/durable-objects/snapshot-aggregator.ts
// Aggregates orderbook ticks into 1-minute OHLC bars

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  EnhancedOrderbookSnapshot,
  AggregatedSnapshot,
  RealtimeTick,
  TickDirection,
} from "../types/orderbook";

/**
 * MinuteBar - accumulates tick data for 1-minute OHLC bars
 * HFT-grade: tracks volume for true VWAP, depth metrics, sequences
 */
interface MinuteBar {
  asset_id: string;
  condition_id: string;
  minute: number;

  // OHLC for best bid
  open_bid: number | null;
  high_bid: number | null;
  low_bid: number | null;
  close_bid: number | null;

  // OHLC for best ask
  open_ask: number | null;
  high_ask: number | null;
  low_ask: number | null;
  close_ask: number | null;

  // Spread tracking
  sum_spread_bps: number;

  // Depth tracking (for averages)
  sum_bid_depth: number;
  sum_ask_depth: number;
  sum_bid_depth_5: number; // Top 5 levels
  sum_ask_depth_5: number; // Top 5 levels
  sum_imbalance: number;

  // Volume tracking for TRUE VWAP calculation
  sum_price_volume_bid: number; // sum(price * size) for bids
  sum_price_volume_ask: number; // sum(price * size) for asks
  sum_volume_bid: number; // total bid volume
  sum_volume_ask: number; // total ask volume

  tick_count: number;

  // Hash chain
  first_hash: string;
  last_hash: string;

  // Sequence tracking
  sequence_start: number;
  sequence_end: number;

  // Timestamps (microseconds)
  first_source_ts: number;
  last_source_ts: number;

  pending_flush: boolean;
}

/**
 * TriggerState - tracks last known state for adaptive triggers
 */
interface TriggerState {
  last_best_bid: number | null;
  last_best_ask: number | null;
  last_mid_price: number | null;
  last_trigger_ts: number;
  recent_volatility_bps: number; // Rolling volatility estimate
  trigger_count_1h: number; // Triggers in last hour for rate limiting
}

/**
 * Adaptive trigger configuration per market type
 */
interface TriggerConfig {
  threshold_bps: number;
  min_interval_ms: number;
  volatility_multiplier: number;
}

// Adaptive trigger configs based on market characteristics
const TRIGGER_CONFIGS: Record<string, TriggerConfig> = {
  high_volume: { threshold_bps: 10, min_interval_ms: 100, volatility_multiplier: 1.0 },
  medium_volume: { threshold_bps: 25, min_interval_ms: 250, volatility_multiplier: 1.5 },
  low_volume: { threshold_bps: 50, min_interval_ms: 500, volatility_multiplier: 2.0 },
  default: { threshold_bps: 25, min_interval_ms: 200, volatility_multiplier: 1.5 },
};

// Configuration constants
const CONFIG = {
  FLUSH_INTERVAL_MS: 60_000,
  MINUTE_BUCKET_MS: 60_000,
  // Adaptive triggers (base values, adjusted per asset)
  DEFAULT_PRICE_CHANGE_THRESHOLD_BPS: 25, // Lowered from 50 for faster triggers
  DEFAULT_MIN_TRIGGER_INTERVAL_MS: 200, // Lowered from 1000 for HFT
  // Memory limits
  MAX_BARS_IN_MEMORY: 10_000,
  MAX_BAR_AGE_MS: 3_600_000, // 1 hour
  MAX_TRIGGERS_IN_MEMORY: 50_000,
  TRIGGER_STALE_MS: 86_400_000, // 24 hours
  // Timestamp validation
  MAX_TIMESTAMP_DRIFT_MS: 3_600_000, // 1 hour
  // Volatility tracking
  VOLATILITY_DECAY: 0.95, // Exponential decay for volatility estimate
} as const;

export class SnapshotAggregator extends DurableObject<Env> {
  private bars: Map<string, MinuteBar> = new Map();
  private triggers: Map<string, TriggerState> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.setAlarm(Date.now() + CONFIG.FLUSH_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/ingest":
        return this.handleIngest(request);
      case "/status":
        return this.handleStatus();
      case "/flush":
        await this.flushAllBars();
        return Response.json({ flushed: true, bars_flushed: this.bars.size });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleIngest(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!Array.isArray(body)) {
      return Response.json({ error: "Body must be an array" }, { status: 400 });
    }

    let aggregated = 0;
    let triggered = 0;
    let skipped = 0;

    for (const item of body) {
      if (!this.isValidSnapshot(item)) {
        skipped++;
        continue;
      }

      const snapshot = item as EnhancedOrderbookSnapshot;

      if (!this.isValidTimestamp(snapshot.source_ts)) {
        skipped++;
        continue;
      }

      this.addToBar(snapshot);
      aggregated++;

      if (this.shouldTrigger(snapshot)) {
        await this.fireTrigger(snapshot);
        triggered++;
      }
    }

    return Response.json({
      aggregated,
      triggered,
      skipped,
      active_bars: this.bars.size,
      active_triggers: this.triggers.size,
    });
  }

  private isValidSnapshot(obj: unknown): obj is EnhancedOrderbookSnapshot {
    if (typeof obj !== "object" || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return (
      typeof o.asset_id === "string" &&
      typeof o.condition_id === "string" &&
      typeof o.source_ts === "number" &&
      Array.isArray(o.bids) &&
      Array.isArray(o.asks)
    );
  }

  private isValidTimestamp(timestampMs: number): boolean {
    const now = Date.now();
    const drift = Math.abs(timestampMs - now);
    return drift <= CONFIG.MAX_TIMESTAMP_DRIFT_MS;
  }

  private addToBar(snapshot: EnhancedOrderbookSnapshot): void {
    const minute = Math.floor(snapshot.source_ts / CONFIG.MINUTE_BUCKET_MS) * CONFIG.MINUTE_BUCKET_MS;
    const key = `${snapshot.asset_id}:${minute}`;

    let bar = this.bars.get(key);

    // Skip updating bars that are pending flush
    if (bar && bar.pending_flush) {
      return;
    }

    // Calculate depth metrics
    const bidDepth = snapshot.bids.reduce((s, b) => s + b.size, 0);
    const askDepth = snapshot.asks.reduce((s, a) => s + a.size, 0);
    const bidDepth5 = snapshot.bids.slice(0, 5).reduce((s, b) => s + b.size, 0);
    const askDepth5 = snapshot.asks.slice(0, 5).reduce((s, a) => s + a.size, 0);
    const imbalance =
      bidDepth + askDepth > 0
        ? (bidDepth - askDepth) / (bidDepth + askDepth)
        : 0;

    // Calculate volume-weighted price contribution for VWAP
    // Use top-of-book size as the "volume" for this tick
    const bidTopSize = snapshot.bids[0]?.size ?? 0;
    const askTopSize = snapshot.asks[0]?.size ?? 0;
    const priceVolumeBid = snapshot.best_bid !== null ? snapshot.best_bid * bidTopSize : 0;
    const priceVolumeAsk = snapshot.best_ask !== null ? snapshot.best_ask * askTopSize : 0;

    if (!bar) {
      bar = {
        asset_id: snapshot.asset_id,
        condition_id: snapshot.condition_id,
        minute,
        // OHLC bid
        open_bid: snapshot.best_bid,
        high_bid: snapshot.best_bid,
        low_bid: snapshot.best_bid,
        close_bid: snapshot.best_bid,
        // OHLC ask
        open_ask: snapshot.best_ask,
        high_ask: snapshot.best_ask,
        low_ask: snapshot.best_ask,
        close_ask: snapshot.best_ask,
        // Spread
        sum_spread_bps: snapshot.spread_bps ?? 0,
        // Depth
        sum_bid_depth: bidDepth,
        sum_ask_depth: askDepth,
        sum_bid_depth_5: bidDepth5,
        sum_ask_depth_5: askDepth5,
        sum_imbalance: imbalance,
        // Volume for TRUE VWAP
        sum_price_volume_bid: priceVolumeBid,
        sum_price_volume_ask: priceVolumeAsk,
        sum_volume_bid: bidTopSize,
        sum_volume_ask: askTopSize,
        // Counts
        tick_count: 1,
        // Hash chain
        first_hash: snapshot.book_hash,
        last_hash: snapshot.book_hash,
        // Sequence
        sequence_start: snapshot.sequence_number,
        sequence_end: snapshot.sequence_number,
        // Timestamps (microseconds)
        first_source_ts: snapshot.source_ts,
        last_source_ts: snapshot.source_ts,
        pending_flush: false,
      };

      this.bars.set(key, bar);
      return;
    }

    // Update existing bar - OHLC
    if (snapshot.best_bid !== null) {
      // Set open if still null (handles case where first tick had null price)
      if (bar.open_bid === null) {
        bar.open_bid = snapshot.best_bid;
      }
      if (bar.high_bid === null || snapshot.best_bid > bar.high_bid) {
        bar.high_bid = snapshot.best_bid;
      }
      if (bar.low_bid === null || snapshot.best_bid < bar.low_bid) {
        bar.low_bid = snapshot.best_bid;
      }
      bar.close_bid = snapshot.best_bid;
    }

    if (snapshot.best_ask !== null) {
      // Set open if still null (handles case where first tick had null price)
      if (bar.open_ask === null) {
        bar.open_ask = snapshot.best_ask;
      }
      if (bar.high_ask === null || snapshot.best_ask > bar.high_ask) {
        bar.high_ask = snapshot.best_ask;
      }
      if (bar.low_ask === null || snapshot.best_ask < bar.low_ask) {
        bar.low_ask = snapshot.best_ask;
      }
      bar.close_ask = snapshot.best_ask;
    }

    // Accumulate spread
    bar.sum_spread_bps += snapshot.spread_bps ?? 0;

    // Accumulate depth
    bar.sum_bid_depth += bidDepth;
    bar.sum_ask_depth += askDepth;
    bar.sum_bid_depth_5 += bidDepth5;
    bar.sum_ask_depth_5 += askDepth5;

    // Accumulate imbalance
    if (bidDepth + askDepth > 0) {
      bar.sum_imbalance += imbalance;
    }

    // Accumulate volume for TRUE VWAP
    bar.sum_price_volume_bid += priceVolumeBid;
    bar.sum_price_volume_ask += priceVolumeAsk;
    bar.sum_volume_bid += bidTopSize;
    bar.sum_volume_ask += askTopSize;

    // Update counters
    bar.tick_count++;
    bar.last_hash = snapshot.book_hash;
    bar.sequence_end = snapshot.sequence_number;
    bar.last_source_ts = snapshot.source_ts;
  }

  /**
   * Determines if a price trigger should fire based on adaptive thresholds
   * Uses volatility-adjusted thresholds and rate limiting
   */
  private shouldTrigger(snapshot: EnhancedOrderbookSnapshot): boolean {
    const state = this.triggers.get(snapshot.asset_id);
    const now = Date.now();

    // Get adaptive config (could be extended to use KV for per-asset config)
    const config = this.getAdaptiveTriggerConfig(snapshot.asset_id, state);

    // Rate limit triggers
    if (state && now - state.last_trigger_ts < config.min_interval_ms) {
      return false;
    }

    // Calculate current mid price
    const midNew =
      snapshot.best_bid !== null && snapshot.best_ask !== null
        ? (snapshot.best_bid + snapshot.best_ask) / 2
        : null;

    if (!state) {
      // First snapshot for this asset - initialize state but don't trigger
      this.triggers.set(snapshot.asset_id, {
        last_best_bid: snapshot.best_bid,
        last_best_ask: snapshot.best_ask,
        last_mid_price: midNew,
        last_trigger_ts: now,
        recent_volatility_bps: 0,
        trigger_count_1h: 0,
      });
      return false;
    }

    // Calculate price change
    const midOld = state.last_mid_price;

    if (midOld !== null && midNew !== null && midOld > 0) {
      const changeBps = Math.abs((midNew - midOld) / midOld) * 10000;

      // Update rolling volatility estimate
      const newVolatility =
        state.recent_volatility_bps * CONFIG.VOLATILITY_DECAY +
        changeBps * (1 - CONFIG.VOLATILITY_DECAY);

      // Calculate adaptive threshold based on recent volatility
      const adaptiveThreshold = Math.max(
        config.threshold_bps,
        newVolatility * config.volatility_multiplier
      );

      // Update state with new mid price and volatility (for next comparison)
      this.triggers.set(snapshot.asset_id, {
        ...state,
        last_mid_price: midNew,
        recent_volatility_bps: newVolatility,
      });

      if (changeBps >= adaptiveThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get adaptive trigger configuration based on asset characteristics
   */
  private getAdaptiveTriggerConfig(assetId: string, state: TriggerState | undefined): TriggerConfig {
    // Could be extended to look up per-asset config from KV
    // For now, use trigger frequency to estimate market activity

    if (!state) {
      return TRIGGER_CONFIGS.default;
    }

    // High trigger count = active market = use tighter thresholds
    if (state.trigger_count_1h > 100) {
      return TRIGGER_CONFIGS.high_volume;
    } else if (state.trigger_count_1h > 20) {
      return TRIGGER_CONFIGS.medium_volume;
    } else if (state.trigger_count_1h < 5) {
      return TRIGGER_CONFIGS.low_volume;
    }

    return TRIGGER_CONFIGS.default;
  }

  /**
   * Calculates tick direction based on mid price movement
   */
  private calculateTickDirection(
    snapshot: EnhancedOrderbookSnapshot,
    state: TriggerState | undefined
  ): TickDirection {
    if (!state || state.last_mid_price === null) {
      return "UNCHANGED";
    }

    const midNew =
      snapshot.best_bid !== null && snapshot.best_ask !== null
        ? (snapshot.best_bid + snapshot.best_ask) / 2
        : null;

    if (midNew === null) {
      return "UNCHANGED";
    }

    if (midNew > state.last_mid_price) {
      return "UP";
    } else if (midNew < state.last_mid_price) {
      return "DOWN";
    }

    return "UNCHANGED";
  }

  /**
   * Fires a realtime tick trigger with HFT-grade fields
   */
  private async fireTrigger(snapshot: EnhancedOrderbookSnapshot): Promise<void> {
    const now = Date.now();
    const state = this.triggers.get(snapshot.asset_id);

    // Calculate tick direction and mid price
    const tickDirection = this.calculateTickDirection(snapshot, state);
    const midPrice =
      snapshot.best_bid !== null && snapshot.best_ask !== null
        ? (snapshot.best_bid + snapshot.best_ask) / 2
        : null;

    // Check for crossed book (error condition)
    const crossed =
      snapshot.best_bid !== null &&
      snapshot.best_ask !== null &&
      snapshot.best_bid >= snapshot.best_ask;

    const tick: RealtimeTick = {
      asset_id: snapshot.asset_id,
      source_ts: snapshot.source_ts,
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      mid_price: midPrice,
      spread_bps: snapshot.spread_bps ?? null,
      tick_direction: tickDirection,
      crossed,
      book_hash: snapshot.book_hash,
      sequence_number: snapshot.sequence_number,
      ingestion_ts: snapshot.ingestion_ts,
    };

    try {
      await this.env.REALTIME_TICK_QUEUE?.send(tick);

      // Only update trigger state AFTER successful send
      // This ensures failed sends can be retried on next trigger
      this.triggers.set(snapshot.asset_id, {
        last_best_bid: snapshot.best_bid,
        last_best_ask: snapshot.best_ask,
        last_mid_price: midPrice,
        last_trigger_ts: now,
        recent_volatility_bps: state?.recent_volatility_bps ?? 0,
        trigger_count_1h: (state?.trigger_count_1h ?? 0) + 1,
      });
    } catch (error) {
      console.error(`[Aggregator] Failed to send realtime tick:`, error);
      // State not updated, so next significant price change will retry
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.flushCompletedBars();
      this.cleanupStaleTriggers();
    } catch (error) {
      console.error(`[Aggregator] Alarm handler error:`, error);
    } finally {
      // Always reschedule alarm, even if flush failed
      await this.ctx.storage.setAlarm(Date.now() + CONFIG.FLUSH_INTERVAL_MS);
    }
  }

  private async flushCompletedBars(): Promise<void> {
    const now = Date.now();
    const currentMinute = Math.floor(now / CONFIG.MINUTE_BUCKET_MS) * CONFIG.MINUTE_BUCKET_MS;
    const oldestAllowed = now - CONFIG.MAX_BAR_AGE_MS;

    const barsToFlush: AggregatedSnapshot[] = [];
    const keysToFlush: string[] = [];

    for (const [key, bar] of this.bars) {
      // Skip bars already pending flush
      if (bar.pending_flush) {
        keysToFlush.push(key);
        barsToFlush.push(this.barToAggregatedSnapshot(bar));
        continue;
      }

      // Flush if minute completed, bar is too old, or memory pressure
      const shouldFlush =
        bar.minute < currentMinute ||
        bar.last_source_ts < oldestAllowed ||
        this.bars.size > CONFIG.MAX_BARS_IN_MEMORY;

      if (shouldFlush) {
        barsToFlush.push(this.barToAggregatedSnapshot(bar));
        keysToFlush.push(key);
      }
    }

    if (barsToFlush.length === 0) {
      return;
    }

    try {
      await this.env.AGGREGATED_SNAPSHOT_QUEUE?.send(barsToFlush);
      // Only delete from memory after successful send
      for (const key of keysToFlush) {
        this.bars.delete(key);
      }
      console.log(`[Aggregator] Flushed ${barsToFlush.length} bars (${this.bars.size} remaining)`);
    } catch (error) {
      console.error(`[Aggregator] Failed to flush bars:`, error);
      // Mark bars as pending flush so we don't add more data to them
      for (const key of keysToFlush) {
        const bar = this.bars.get(key);
        if (bar) {
          bar.pending_flush = true;
        }
      }

      // Emergency cleanup if we're at memory limit
      if (this.bars.size > CONFIG.MAX_BARS_IN_MEMORY) {
        const sortedBars = Array.from(this.bars.entries())
          .sort((a, b) => a[1].last_source_ts - b[1].last_source_ts);
        const toClear = sortedBars.slice(0, Math.floor(CONFIG.MAX_BARS_IN_MEMORY * 0.2));
        for (const [key] of toClear) {
          this.bars.delete(key);
        }
        console.warn(`[Aggregator] Emergency cleared ${toClear.length} old bars due to memory pressure`);
      }
    }
  }

  private cleanupStaleTriggers(): void {
    const now = Date.now();
    const staleThreshold = now - CONFIG.TRIGGER_STALE_MS;
    let cleanedCount = 0;

    for (const [assetId, state] of this.triggers) {
      if (state.last_trigger_ts < staleThreshold) {
        this.triggers.delete(assetId);
        cleanedCount++;
      }
    }

    // Also enforce max triggers limit
    if (this.triggers.size > CONFIG.MAX_TRIGGERS_IN_MEMORY) {
      const sortedTriggers = Array.from(this.triggers.entries())
        .sort((a, b) => a[1].last_trigger_ts - b[1].last_trigger_ts);
      const toRemove = sortedTriggers.slice(0, this.triggers.size - CONFIG.MAX_TRIGGERS_IN_MEMORY);
      for (const [assetId] of toRemove) {
        this.triggers.delete(assetId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Aggregator] Cleaned up ${cleanedCount} stale triggers`);
    }
  }

  private async flushAllBars(): Promise<void> {
    const barsToFlush: AggregatedSnapshot[] = [];
    for (const bar of this.bars.values()) {
      barsToFlush.push(this.barToAggregatedSnapshot(bar));
    }
    if (barsToFlush.length > 0) {
      try {
        await this.env.AGGREGATED_SNAPSHOT_QUEUE?.send(barsToFlush);
        this.bars.clear();
      } catch (error) {
        console.error(`[Aggregator] Failed to flush all bars:`, error);
      }
    }
  }

  /**
   * Converts a MinuteBar to AggregatedSnapshot with TRUE VWAP calculation
   * VWAP = sum(price * volume) / sum(volume)
   */
  private barToAggregatedSnapshot(bar: MinuteBar): AggregatedSnapshot {
    // Calculate TRUE VWAP (volume-weighted average price)
    const totalVolume = bar.sum_volume_bid + bar.sum_volume_ask;
    const totalPriceVolume = bar.sum_price_volume_bid + bar.sum_price_volume_ask;

    let vwapMid: number | null = null;
    if (totalVolume > 0) {
      // True VWAP: sum(price * volume) / sum(volume)
      vwapMid = totalPriceVolume / totalVolume;
    } else if (bar.close_bid !== null && bar.close_ask !== null) {
      // Fallback to simple mid if no volume (shouldn't happen normally)
      vwapMid = (bar.close_bid + bar.close_ask) / 2;
    }

    return {
      asset_id: bar.asset_id,
      condition_id: bar.condition_id,
      minute: bar.minute,

      // OHLC bid
      open_bid: bar.open_bid,
      high_bid: bar.high_bid,
      low_bid: bar.low_bid,
      close_bid: bar.close_bid,

      // OHLC ask
      open_ask: bar.open_ask,
      high_ask: bar.high_ask,
      low_ask: bar.low_ask,
      close_ask: bar.close_ask,

      // True VWAP
      vwap_mid: vwapMid,

      // Depth metrics (averages)
      avg_spread_bps:
        bar.tick_count > 0 ? bar.sum_spread_bps / bar.tick_count : 0,
      avg_bid_depth:
        bar.tick_count > 0 ? bar.sum_bid_depth / bar.tick_count : 0,
      avg_ask_depth:
        bar.tick_count > 0 ? bar.sum_ask_depth / bar.tick_count : 0,
      avg_bid_depth_5:
        bar.tick_count > 0 ? bar.sum_bid_depth_5 / bar.tick_count : 0,
      avg_ask_depth_5:
        bar.tick_count > 0 ? bar.sum_ask_depth_5 / bar.tick_count : 0,
      avg_imbalance:
        bar.tick_count > 0 ? bar.sum_imbalance / bar.tick_count : 0,

      // Volume totals (for VWAP verification)
      total_bid_volume: bar.sum_volume_bid,
      total_ask_volume: bar.sum_volume_ask,

      tick_count: bar.tick_count,

      // Microsecond timestamps
      first_source_ts: bar.first_source_ts,
      last_source_ts: bar.last_source_ts,

      // Hash chain
      first_hash: bar.first_hash,
      last_hash: bar.last_hash,

      // Sequence tracking
      sequence_start: bar.sequence_start,
      sequence_end: bar.sequence_end,
    };
  }

  private handleStatus(): Response {
    const barsByAsset = new Map<string, number>();
    for (const bar of this.bars.values()) {
      const count = barsByAsset.get(bar.asset_id) || 0;
      barsByAsset.set(bar.asset_id, count + 1);
    }

    return Response.json({
      active_bars: this.bars.size,
      active_triggers: this.triggers.size,
      bars_by_asset: Object.fromEntries(barsByAsset),
    });
  }
}
