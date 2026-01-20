// src/adapters/base/trigger-evaluator.ts
// Trigger evaluator interface for checking trigger conditions

import type { MarketSource } from "../../core/enums";
import type { BBOSnapshot } from "../../core/orderbook";
import type {
  TriggerType,
  Trigger,
  TriggerEvent,
  TriggerContext,
  TriggerEvaluationResult,
} from "../../core/triggers";

/**
 * Trigger evaluator interface
 * Evaluates trigger conditions and generates events
 *
 * Split into:
 * - Generic evaluators: Work across all markets (PRICE_ABOVE, SPREAD_NARROW, etc.)
 * - Market-specific evaluators: Only for certain market types (ARBITRAGE_BUY/SELL)
 */
export interface ITriggerEvaluator {
  /** Evaluator name for logging */
  readonly name: string;

  /** Market source this evaluator is for (null = all markets) */
  readonly marketSource: MarketSource | null;

  /**
   * Get trigger types supported by this evaluator
   */
  getSupportedTypes(): TriggerType[];

  /**
   * Check if this evaluator can handle a trigger type
   *
   * @param type - Trigger type to check
   */
  supportsType(type: TriggerType): boolean;

  /**
   * Evaluate a trigger condition against current market state
   *
   * @param trigger - The trigger to evaluate
   * @param snapshot - Current BBO snapshot
   * @param context - Additional context (price history, other assets' BBO, etc.)
   * @returns Evaluation result with optional event
   */
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

  /**
   * Helper to create a trigger event
   */
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
      latency_us: nowUs - snapshot.source_ts,
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      bid_size: snapshot.bid_size,
      ask_size: snapshot.ask_size,
      mid_price: snapshot.mid_price,
      spread_bps: snapshot.spread_bps,
      threshold: trigger.condition.threshold,
      actual_value: actualValue,
      book_hash: snapshot.book_hash,
      sequence_number: snapshot.sequence_number,
      metadata: trigger.metadata,
      ...extras,
    };
  }

  /**
   * Helper to create a non-fired result
   */
  protected notFired(): TriggerEvaluationResult {
    return { fired: false };
  }

  /**
   * Helper to create a fired result
   */
  protected fired(event: TriggerEvent): TriggerEvaluationResult {
    return { fired: true, event };
  }
}
