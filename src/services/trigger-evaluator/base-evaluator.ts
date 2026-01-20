// src/services/trigger-evaluator/base-evaluator.ts
// Generic trigger evaluation logic that works across all market types

import type { MarketSource } from "../../core/enums";
import type {
  TriggerType,
  Trigger,
  TriggerContext,
  TriggerEvaluationResult,
  PriceHistoryEntry,
} from "../../core/triggers";
import type { BBOSnapshot } from "../../core/orderbook";
import { BaseTriggerEvaluator as BaseTriggerEvaluatorInterface } from "../../adapters/base/trigger-evaluator";

/**
 * Generic trigger evaluator for market-agnostic triggers
 * These triggers work across all market types (prediction, DEX, spot, etc.)
 */
export class GenericTriggerEvaluator extends BaseTriggerEvaluatorInterface {
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
    if (snapshot.mid_price === null || !window_ms) {
      return this.notFired();
    }

    const history = context.priceHistory.get(snapshot.asset_id);
    if (!history || history.length === 0) {
      return this.notFired();
    }

    const windowStart = snapshot.source_ts - window_ms;
    const oldEntry = history.find((h) => h.ts >= windowStart);

    if (oldEntry && oldEntry.mid_price > 0) {
      const pctChange =
        Math.abs((snapshot.mid_price - oldEntry.mid_price) / oldEntry.mid_price) * 100;
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
}

/**
 * Update price history for PRICE_MOVE triggers
 * Returns pruned history with old entries removed
 */
export function updatePriceHistory(
  history: PriceHistoryEntry[],
  snapshot: BBOSnapshot,
  maxAgeMs: number = 60000,
  maxEntries: number = 1000
): PriceHistoryEntry[] {
  if (snapshot.mid_price === null) {
    return history;
  }

  const newHistory = [...history, { ts: snapshot.source_ts, mid_price: snapshot.mid_price }];

  // Prune old entries
  const cutoff = snapshot.source_ts - maxAgeMs;
  let firstValidIdx = 0;
  while (firstValidIdx < newHistory.length && newHistory[firstValidIdx].ts < cutoff) {
    firstValidIdx++;
  }

  // Enforce max entries limit
  const startIdx = Math.max(firstValidIdx, newHistory.length - maxEntries);

  return startIdx > 0 ? newHistory.slice(startIdx) : newHistory;
}
