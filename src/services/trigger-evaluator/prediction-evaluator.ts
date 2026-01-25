// src/services/trigger-evaluator/prediction-evaluator.ts
// Prediction market specific trigger evaluation (arbitrage detection)

import type { MarketSource } from "../../core/enums";
import type {
  TriggerType,
  Trigger,
  TriggerContext,
  TriggerEvaluationResult,
} from "../../core/triggers";
import type { BBOSnapshot } from "../../core/orderbook";
import { BaseTriggerEvaluator, GenericTriggerEvaluator } from "./base-evaluator";
import type { ITriggerEvaluator } from "./base-evaluator";

/**
 * Prediction market trigger evaluator
 * Extends generic evaluator with prediction market specific triggers:
 * - ARBITRAGE_BUY: YES_ask + NO_ask < threshold (buy both for guaranteed profit)
 * - ARBITRAGE_SELL: YES_bid + NO_bid > threshold (sell both for guaranteed profit)
 *
 * These triggers require access to both YES and NO token orderbooks to detect
 * arbitrage opportunities in binary prediction markets (Polymarket, Kalshi, etc.)
 */
export class PredictionMarketTriggerEvaluator extends BaseTriggerEvaluator {
  readonly name = "PredictionMarketTriggerEvaluator";
  readonly marketSource: MarketSource;

  private genericEvaluator: GenericTriggerEvaluator;
  private readonly STALE_DATA_THRESHOLD_MS = 5000; // 5 seconds

  constructor(marketSource: MarketSource = "polymarket") {
    super();
    this.marketSource = marketSource;
    this.genericEvaluator = new GenericTriggerEvaluator();
  }

  getSupportedTypes(): TriggerType[] {
    return [
      ...this.genericEvaluator.getSupportedTypes(),
      "ARBITRAGE_BUY",
      "ARBITRAGE_SELL",
      "MULTI_OUTCOME_ARBITRAGE",
    ];
  }

  evaluate(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    context: TriggerContext
  ): TriggerEvaluationResult {
    const { type, threshold, counterpart_asset_id } = trigger.condition;

    // Handle prediction market specific triggers
    switch (type) {
      case "ARBITRAGE_BUY":
        return this.evaluateArbitrageBuy(
          trigger,
          snapshot,
          threshold,
          counterpart_asset_id,
          context
        );

      case "ARBITRAGE_SELL":
        return this.evaluateArbitrageSell(
          trigger,
          snapshot,
          threshold,
          counterpart_asset_id,
          context
        );

      default:
        // Delegate to generic evaluator for common triggers
        return this.genericEvaluator.evaluate(trigger, snapshot, context);
    }
  }

  /**
   * ARBITRAGE_BUY: Detect when buying both YES and NO tokens is profitable
   *
   * In binary prediction markets:
   * - YES + NO always pays out $1 at resolution
   * - If YES_ask + NO_ask < $1, you can buy both for less than $1 and profit
   * - threshold is typically 0.99 or lower to account for fees
   *
   * Example:
   * - YES ask: $0.48
   * - NO ask: $0.48
   * - Sum: $0.96 < $1.00 threshold
   * - Profit: $0.04 per share (400 bps)
   */
  private evaluateArbitrageBuy(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    counterpart_asset_id: string | undefined,
    context: TriggerContext
  ): TriggerEvaluationResult {
    if (!counterpart_asset_id || snapshot.best_ask === null) {
      return this.notFired();
    }

    // Get counterpart BBO from context
    const counterpartBBO = context.latestBBO.get(counterpart_asset_id);
    if (!counterpartBBO || counterpartBBO.best_ask === null) {
      return this.notFired();
    }

    // CRITICAL: Check BOTH explicit stale flag AND time delta to prevent false signals
    // Stale flag is set proactively when counterpart data is old relative to new updates
    if (counterpartBBO.stale) {
      return this.notFired();
    }
    if (Math.abs(snapshot.source_ts - counterpartBBO.ts) > this.STALE_DATA_THRESHOLD_MS) {
      return this.notFired();
    }

    const sumOfAsks = snapshot.best_ask + counterpartBBO.best_ask;

    if (sumOfAsks < threshold) {
      // Profit = 1 - sumOfAsks (guaranteed payout is $1)
      const profitBps = (1 - sumOfAsks) * 10000;

      return this.fired(
        this.createTriggerEvent(trigger, snapshot, sumOfAsks, {
          counterpart_asset_id,
          counterpart_best_bid: counterpartBBO.best_bid,
          counterpart_best_ask: counterpartBBO.best_ask,
          sum_of_asks: sumOfAsks,
          potential_profit_bps: profitBps,
        })
      );
    }

    return this.notFired();
  }

  /**
   * ARBITRAGE_SELL: Detect when selling both YES and NO tokens is profitable
   *
   * In binary prediction markets:
   * - If you hold both YES and NO, you can sell both
   * - If YES_bid + NO_bid > $1, you receive more than the $1 payout
   * - threshold is typically 1.01 or higher to account for fees
   *
   * Example:
   * - YES bid: $0.52
   * - NO bid: $0.52
   * - Sum: $1.04 > $1.00 threshold
   * - Profit: $0.04 per share (400 bps)
   */
  private evaluateArbitrageSell(
    trigger: Trigger,
    snapshot: BBOSnapshot,
    threshold: number,
    counterpart_asset_id: string | undefined,
    context: TriggerContext
  ): TriggerEvaluationResult {
    if (!counterpart_asset_id || snapshot.best_bid === null) {
      return this.notFired();
    }

    // Get counterpart BBO from context
    const counterpartBBO = context.latestBBO.get(counterpart_asset_id);
    if (!counterpartBBO || counterpartBBO.best_bid === null) {
      return this.notFired();
    }

    // CRITICAL: Check BOTH explicit stale flag AND time delta to prevent false signals
    // Stale flag is set proactively when counterpart data is old relative to new updates
    if (counterpartBBO.stale) {
      return this.notFired();
    }
    if (Math.abs(snapshot.source_ts - counterpartBBO.ts) > this.STALE_DATA_THRESHOLD_MS) {
      return this.notFired();
    }

    const sumOfBids = snapshot.best_bid + counterpartBBO.best_bid;

    if (sumOfBids > threshold) {
      // Profit = sumOfBids - 1 (you receive more than the $1 you'll pay out)
      const profitBps = (sumOfBids - 1) * 10000;

      return this.fired(
        this.createTriggerEvent(trigger, snapshot, sumOfBids, {
          counterpart_asset_id,
          counterpart_best_bid: counterpartBBO.best_bid,
          counterpart_best_ask: counterpartBBO.best_ask,
          sum_of_bids: sumOfBids,
          potential_profit_bps: profitBps,
        })
      );
    }

    return this.notFired();
  }
}

/**
 * Factory function to create the appropriate trigger evaluator
 * based on market type
 */
export function createTriggerEvaluator(
  marketSource: MarketSource,
  marketType: "prediction" | "dex" | "spot" | "futures"
): ITriggerEvaluator {
  switch (marketType) {
    case "prediction":
      return new PredictionMarketTriggerEvaluator(marketSource);
    default:
      // Use generic evaluator for other market types
      return new GenericTriggerEvaluator();
  }
}
