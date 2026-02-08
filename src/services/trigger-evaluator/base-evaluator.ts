// src/services/trigger-evaluator/base-evaluator.ts
// Generic trigger evaluation logic that works across all market types

import type { MarketSource } from "../../core/enums";
import type {
  TriggerType,
  Trigger,
  TriggerEvent,
  TriggerContext,
  TriggerEvaluationResult,
  PriceHistoryEntry,
} from "../../core/triggers";
import type { BBOSnapshot } from "../../core/orderbook";

/**
 * Trigger evaluator interface
 * Evaluates trigger conditions and generates events
 */
export interface ITriggerEvaluator {
  /** Evaluator name for logging */
  readonly name: string;

  /** Market source this evaluator is for (null = all markets) */
  readonly marketSource: MarketSource | null;

  /** Get trigger types supported by this evaluator */
  getSupportedTypes(): TriggerType[];

  /** Check if this evaluator can handle a trigger type */
  supportsType(type: TriggerType): boolean;

  /** Evaluate a trigger condition against current market state */
  evaluate(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    context: TriggerContext
  ): TriggerEvaluationResult;
}

/**
 * Base class for trigger evaluators with common functionality
 */
export abstract class BaseTriggerEvaluator implements ITriggerEvaluator {
  abstract readonly name: string;
  abstract readonly marketSource: MarketSource | null;

  abstract getSupportedTypes(): TriggerType[];

  supportsType(type: TriggerType): boolean {
    return this.getSupportedTypes().includes(type);
  }

  abstract evaluate(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    context: TriggerContext
  ): TriggerEvaluationResult;

  /** Helper to create a trigger event */
  protected createTriggerEvent(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    actualValue: number,
    extras?: Partial<TriggerEvent>
  ): TriggerEvent {
    const nowUs = Date.now() * 1000;
    return {
      trigger_id: trigger.id,
      trigger_type: trigger.condition.type,
      market_source: snapshot.market_source,
      asset_id: snapshot.asset_id,
      condition_id: snapshot.condition_id,
      fired_at: nowUs,
      // Dual latency tracking
      total_latency_us: nowUs - snapshot.source_ts,
      processing_latency_us: nowUs - snapshot.ingestion_ts,
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      bid_size: snapshot.bid_size,
      ask_size: snapshot.ask_size,
      spread_bps: snapshot.spread_bps,
      threshold: trigger.condition.threshold,
      actual_value: actualValue,
      book_hash: snapshot.book_hash,
      sequence_number: snapshot.sequence_number,
      metadata: trigger.metadata,
      ...extras,
    };
  }

  /** Helper to create a non-fired result */
  protected notFired(): TriggerEvaluationResult {
    return { fired: false };
  }

  /** Helper to create a fired result */
  protected fired(event: TriggerEvent): TriggerEvaluationResult {
    return { fired: true, event };
  }
}

/**
 * Generic trigger evaluator for market-agnostic triggers
 * These triggers work across all market types (prediction, DEX, spot, etc.)
 */
export class GenericTriggerEvaluator extends BaseTriggerEvaluator {
  readonly name = "GenericTriggerEvaluator";
  readonly marketSource: MarketSource | null = null; // Works for all markets

  getSupportedTypes(): TriggerType[] {
    return [
      "PRICE_ABOVE",
      "PRICE_BELOW",
      "SPREAD_NARROW",
      "SPREAD_WIDE",
      "IMBALANCE_BID",
      "IMBALANCE_ASK",
      "SIZE_SPIKE",
      "PRICE_MOVE",
      "CROSSED_BOOK",
      "EMPTY_BOOK",
      // HFT Triggers for Avellaneda-Stoikov market making
      "VOLATILITY_SPIKE",
      "MICROPRICE_DIVERGENCE",
      "IMBALANCE_SHIFT",
      "MID_PRICE_TREND",
      "QUOTE_VELOCITY",
      "STALE_QUOTE",
      "LARGE_FILL",
    ];
  }

  evaluate(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    context: TriggerContext
  ): TriggerEvaluationResult {
    const { type, threshold, side, window_ms } = trigger.condition;

    switch (type) {
      case "PRICE_ABOVE":
        return this.evaluatePriceAbove(trigger, snapshot, threshold, side);

      case "PRICE_BELOW":
        return this.evaluatePriceBelow(trigger, snapshot, threshold, side);

      case "SPREAD_NARROW":
        return this.evaluateSpreadNarrow(trigger, snapshot, threshold);

      case "SPREAD_WIDE":
        return this.evaluateSpreadWide(trigger, snapshot, threshold);

      case "IMBALANCE_BID":
        return this.evaluateImbalanceBid(trigger, snapshot, threshold);

      case "IMBALANCE_ASK":
        return this.evaluateImbalanceAsk(trigger, snapshot, threshold);

      case "SIZE_SPIKE":
        return this.evaluateSizeSpike(trigger, snapshot, threshold, side);

      case "PRICE_MOVE":
        return this.evaluatePriceMove(trigger, snapshot, threshold, window_ms, context);

      case "CROSSED_BOOK":
        return this.evaluateCrossedBook(trigger, snapshot);

      case "EMPTY_BOOK":
        return this.evaluateEmptyBook(trigger, snapshot);

      default:
        return this.notFired();
    }
  }

  private evaluatePriceAbove(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    side?: "BID" | "ASK"
  ): TriggerEvaluationResult {
    const price = side === "ASK" ? snapshot.best_ask : snapshot.best_bid;
    if (price !== null && price > threshold) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, price));
    }
    return this.notFired();
  }

  private evaluatePriceBelow(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    side?: "BID" | "ASK"
  ): TriggerEvaluationResult {
    const price = side === "ASK" ? snapshot.best_ask : snapshot.best_bid;
    if (price !== null && price < threshold) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, price));
    }
    return this.notFired();
  }

  private evaluateSpreadNarrow(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number
  ): TriggerEvaluationResult {
    if (snapshot.spread_bps !== null && snapshot.spread_bps < threshold) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, snapshot.spread_bps));
    }
    return this.notFired();
  }

  private evaluateSpreadWide(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number
  ): TriggerEvaluationResult {
    if (snapshot.spread_bps !== null && snapshot.spread_bps > threshold) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, snapshot.spread_bps));
    }
    return this.notFired();
  }

  private evaluateImbalanceBid(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number
  ): TriggerEvaluationResult {
    if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
      const total = snapshot.bid_size + snapshot.ask_size;
      if (total > 0) {
        const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
        if (imbalance > threshold) {
          return this.fired(this.createTriggerEvent(trigger, snapshot, imbalance));
        }
      }
    }
    return this.notFired();
  }

  private evaluateImbalanceAsk(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number
  ): TriggerEvaluationResult {
    if (snapshot.bid_size !== null && snapshot.ask_size !== null) {
      const total = snapshot.bid_size + snapshot.ask_size;
      if (total > 0) {
        const imbalance = (snapshot.bid_size - snapshot.ask_size) / total;
        if (imbalance < -threshold) {
          return this.fired(this.createTriggerEvent(trigger, snapshot, imbalance));
        }
      }
    }
    return this.notFired();
  }

  private evaluateSizeSpike(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    side?: "BID" | "ASK"
  ): TriggerEvaluationResult {
    const size = side === "ASK" ? snapshot.ask_size : snapshot.bid_size;
    if (size !== null && size > threshold) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, size));
    }
    return this.notFired();
  }

  private evaluatePriceMove(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    window_ms: number | undefined,
    context: TriggerContext
  ): TriggerEvaluationResult {
    // Compute midpoint for accurate price movement detection
    if (snapshot.best_bid === null || snapshot.best_ask === null || !window_ms) {
      return this.notFired();
    }

    const history = context.priceHistory.get(snapshot.asset_id);
    if (!history || history.length === 0) {
      return this.notFired();
    }

    // Convert window_ms to microseconds (source_ts is in microseconds)
    const windowStartUs = snapshot.source_ts - (window_ms * 1000);

    // Find oldest entry within the window using explicit loop
    // History is sorted ascending by timestamp, so first match is oldest in window
    let baselineEntry: PriceHistoryEntry | null = null;
    for (let i = 0; i < history.length; i++) {
      if (history[i].ts >= windowStartUs) {
        baselineEntry = history[i];
        break;
      }
    }

    if (baselineEntry && baselineEntry.price > 0) {
      const currentMidPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
      const pctChange =
        Math.abs((currentMidPrice - baselineEntry.price) / baselineEntry.price) * 100;
      if (pctChange >= threshold) {
        return this.fired(this.createTriggerEvent(trigger, snapshot, pctChange));
      }
    }

    return this.notFired();
  }

  private evaluateCrossedBook(
    trigger: Trigger,
    snapshot: BBOSnapshot
  ): TriggerEvaluationResult {
    if (
      snapshot.best_bid !== null &&
      snapshot.best_ask !== null &&
      snapshot.best_bid >= snapshot.best_ask
    ) {
      return this.fired(
        this.createTriggerEvent(trigger, snapshot, snapshot.best_bid - snapshot.best_ask)
      );
    }
    return this.notFired();
  }

  /**
   * EMPTY_BOOK: Detect when both sides of the book are empty
   *
   * This is a critical market state indicating:
   * - Market halt or suspension
   * - Liquidity withdrawal (all LPs pulled quotes)
   * - Data gap or connection issue
   * - Pre-market or post-market state
   *
   * Fires when both bid_size and ask_size are null or zero.
   * The threshold is ignored for this trigger type.
   * actualValue is 0 when fired.
   */
  private evaluateEmptyBook(
    trigger: Trigger,
    snapshot: BBOSnapshot
  ): TriggerEvaluationResult {
    const bidEmpty = snapshot.bid_size === null || snapshot.bid_size === 0;
    const askEmpty = snapshot.ask_size === null || snapshot.ask_size === 0;

    if (bidEmpty && askEmpty) {
      return this.fired(this.createTriggerEvent(trigger, snapshot, 0));
    }
    return this.notFired();
  }
}

/**
 * Update price history for PRICE_MOVE triggers
 * Returns pruned history with old entries removed
 *
 * OPTIMIZATION: Uses binary search O(log n) instead of linear scan O(n)
 * for finding the cutoff point, since history is sorted by timestamp.
 * Also includes early return when no pruning is needed.
 */
export function updatePriceHistory(
  history: PriceHistoryEntry[],
  snapshot: BBOSnapshot,
  maxAgeMs: number = 60000,
  maxEntries: number = 1000
): PriceHistoryEntry[] {
  // Compute midpoint from best_bid and best_ask for accurate price movement detection
  if (snapshot.best_bid === null || snapshot.best_ask === null) {
    return history;
  }

  // Add new entry (mutates in place for better performance)
  const midPrice = (snapshot.best_bid + snapshot.best_ask) / 2;
  history.push({ ts: snapshot.source_ts, price: midPrice });

  // Calculate cutoff once, reuse below
  const cutoffUs = snapshot.source_ts - (maxAgeMs * 1000);

  // Fast path: if oldest entry is still valid and under count limit, no pruning needed
  if (history[0].ts >= cutoffUs && history.length <= maxEntries) {
    return history;
  }

  // Binary search for first valid entry using lower-bound pattern
  // O(log n) vs O(n) for linear scan - critical for high-frequency triggers
  let left = 0;
  let right = history.length;
  while (left < right) {
    const mid = (left + right) >>> 1; // Unsigned right shift = floor division by 2
    if (history[mid].ts < cutoffUs) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Determine final start index (consider both time-based and count-based limits)
  const startIdx = Math.max(left, history.length - maxEntries);

  // Slice if needed, otherwise return as-is
  return startIdx > 0 ? history.slice(startIdx) : history;
}
