// src/services/trigger-evaluator/compound-evaluator.ts
// Compound trigger evaluator for multi-market conditions

import type { BBOSnapshot } from "../../types/orderbook";
import type {
  CompoundTrigger,
  CompoundCondition,
  CompoundTriggerState,
  CompoundTriggerEvent,
  TriggerEvent,
} from "../../core/triggers";
import { isCompoundTrigger } from "../../core/triggers";
import type { CrossShardTriggerNotification } from "../graph/types";
import { CrossShardService, allPairs } from "../graph/graph-cache";

/**
 * Result of evaluating a single condition.
 */
interface ConditionEvaluationResult {
  fired: boolean;
  actual_value: number;
}

/**
 * Result of compound trigger evaluation.
 */
interface CompoundEvaluationResult {
  shouldFire: boolean;
  firedConditions: number[];
  conditionResults: Array<{
    index: number;
    market_id: string;
    asset_id: string;
    fired: boolean;
    actual_value?: number;
  }>;
}

/**
 * CompoundTriggerEvaluator handles evaluation of multi-condition triggers
 * that may span multiple markets and shards.
 *
 * Key features:
 * - Tracks partial condition fires across updates
 * - Supports ALL_OF, ANY_OF, and N_OF_M evaluation modes
 * - Coordinates with other shards via KV for cross-shard triggers
 * - Emits graph edge signals when triggers fire
 * - Tracks consecutive misses for gradual edge decay
 */
export class CompoundTriggerEvaluator {
  // State tracking for partial condition fires
  private triggerState: Map<string, CompoundTriggerState> = new Map();

  // Stale state cleanup threshold (60 seconds)
  private readonly STALE_STATE_THRESHOLD_MS = 60000;

  // Cross-shard service for multi-shard triggers
  private crossShardService: CrossShardService | null = null;

  // Shard identifier
  private shardId: string;

  // ============================================================
  // MISS TRACKING FOR GRADUAL DECAY
  // Track consecutive non-fires to emit decay signals
  // ============================================================
  private triggerMissCount: Map<string, number> = new Map();
  private readonly MISS_THRESHOLD = 100; // Emit decay signal every 100 misses
  private readonly MISS_DECAY_STRENGTH = -0.1; // Gentle negative signal

  // Graph queue for emitting edge signals (injected)
  private graphQueue: Queue<import("../graph/types").GraphQueueMessage> | null = null;

  constructor(
    shardId: string,
    private readonly crossShardKV?: KVNamespace,
    graphQueue?: Queue<import("../graph/types").GraphQueueMessage>
  ) {
    this.shardId = shardId;
    if (crossShardKV) {
      this.crossShardService = new CrossShardService(crossShardKV);
    }
    this.graphQueue = graphQueue || null;
  }

  /**
   * Evaluate a compound trigger against a BBO update.
   *
   * Uses optimistic locking to prevent race conditions when multiple concurrent
   * evaluations occur (e.g., rapid BBO updates from different assets in the same trigger).
   *
   * @param trigger - The compound trigger to evaluate
   * @param snapshot - The BBO snapshot that triggered evaluation
   * @param latestBBO - Map of all latest BBO data by asset_id
   * @returns Evaluation result with fire decision and condition status
   */
  async evaluate(
    trigger: CompoundTrigger,
    snapshot: BBOSnapshot,
    latestBBO: Map<string, {
      best_bid: number | null;
      best_ask: number | null;
      bid_size: number | null;
      ask_size: number | null;
      ts: number;
      stale: boolean;
    }>
  ): Promise<CompoundEvaluationResult> {
    // Get or initialize state for this trigger
    let state = this.triggerState.get(trigger.id);
    if (!state) {
      state = {
        trigger_id: trigger.id,
        fired_conditions: new Set(),
        last_evaluation: Date.now(),
        condition_values: new Map(),
        version: 0,
      };
      this.triggerState.set(trigger.id, state);
    }

    // Optimistic locking: capture state version at start of evaluation
    const startVersion = state.version;
    const now = Date.now();

    // Check staleness using version + time
    const isStale = now - state.last_evaluation > this.STALE_STATE_THRESHOLD_MS;

    // Clone current state for this evaluation (isolation from concurrent evaluations)
    // This prevents one evaluation from seeing partial updates from another
    const firedConditions = isStale ? new Set<string>() : new Set(state.fired_conditions);
    const conditionValues = isStale ? new Map<string, number>() : new Map(state.condition_values);

    const results: Array<{
      index: number;
      market_id: string;
      asset_id: string;
      fired: boolean;
      actual_value?: number;
    }> = [];

    // Evaluate each condition against cloned state
    for (let i = 0; i < trigger.conditions.length; i++) {
      const condition = trigger.conditions[i];

      // Check if this condition applies to the current snapshot
      if (condition.asset_id !== snapshot.asset_id) {
        // Use cloned state for conditions not in this update
        const previouslyFired = firedConditions.has(String(i));
        const cachedValue = conditionValues.get(String(i));

        results.push({
          index: i,
          market_id: condition.market_id,
          asset_id: condition.asset_id,
          fired: previouslyFired,
          actual_value: cachedValue,
        });
        continue;
      }

      // Evaluate this condition against the current snapshot
      const evalResult = this.evaluateCondition(condition, snapshot, latestBBO);

      // Update cloned state (not the original)
      if (evalResult.fired) {
        firedConditions.add(String(i));
        conditionValues.set(String(i), evalResult.actual_value);
      } else {
        firedConditions.delete(String(i));
        conditionValues.delete(String(i));
      }

      results.push({
        index: i,
        market_id: condition.market_id,
        asset_id: condition.asset_id,
        fired: evalResult.fired,
        actual_value: evalResult.fired ? evalResult.actual_value : undefined,
      });
    }

    // For cross-shard triggers, publish our state and aggregate
    if (trigger.cross_shard && this.crossShardService) {
      await this.publishCrossShardState(trigger, results);
      const crossShardResult = await this.aggregateCrossShardState(trigger);

      // Atomic state update with version check (optimistic locking)
      const currentState = this.triggerState.get(trigger.id);
      if (currentState && currentState.version === startVersion) {
        if (crossShardResult.shouldFire) {
          currentState.fired_conditions.clear();
          currentState.condition_values.clear();
          this.triggerMissCount.delete(trigger.id);
        } else {
          currentState.fired_conditions = firedConditions;
          currentState.condition_values = conditionValues;
          await this.trackTriggerMiss(trigger);
        }
        currentState.last_evaluation = now;
        currentState.version++;
      } else {
        // Concurrent modification detected - log and let newer evaluation win
        console.warn(
          `[CompoundTrigger] Skipping stale cross-shard state update for ${trigger.id} ` +
          `(version: expected ${startVersion}, got ${currentState?.version})`
        );
      }

      return {
        shouldFire: crossShardResult.shouldFire,
        firedConditions: crossShardResult.firedConditions,
        conditionResults: results,
      };
    }

    // Local evaluation (single-shard trigger)
    const firedIndices = results
      .filter(r => r.fired)
      .map(r => r.index);

    const shouldFire = this.checkFireCondition(
      trigger.compound_mode,
      firedIndices.length,
      trigger.conditions.length,
      trigger.compound_threshold
    );

    // Atomic state update with version check (optimistic locking)
    const currentState = this.triggerState.get(trigger.id);
    if (currentState && currentState.version === startVersion) {
      // No concurrent modification - safe to update
      if (shouldFire) {
        currentState.fired_conditions.clear();
        currentState.condition_values.clear();
        this.triggerMissCount.delete(trigger.id);
      } else {
        // Commit our evaluation's state changes
        currentState.fired_conditions = firedConditions;
        currentState.condition_values = conditionValues;
        await this.trackTriggerMiss(trigger);
      }
      currentState.last_evaluation = now;
      currentState.version++;
    } else {
      // Concurrent modification detected - the other evaluation likely processed newer data
      console.warn(
        `[CompoundTrigger] Skipping stale state update for ${trigger.id} ` +
        `(version: expected ${startVersion}, got ${currentState?.version})`
      );
    }

    return {
      shouldFire,
      firedConditions: firedIndices,
      conditionResults: results,
    };
  }

  /**
   * Evaluate a single condition against a BBO snapshot.
   */
  private evaluateCondition(
    condition: CompoundCondition,
    snapshot: BBOSnapshot,
    latestBBO: Map<string, {
      best_bid: number | null;
      best_ask: number | null;
      bid_size: number | null;
      ask_size: number | null;
      ts: number;
      stale: boolean;
    }>
  ): ConditionEvaluationResult {
    const { type, threshold, side } = condition;

    // Get BBO data for this asset
    const bbo = latestBBO.get(condition.asset_id);
    if (!bbo) {
      return { fired: false, actual_value: 0 };
    }

    const { best_bid, best_ask, bid_size, ask_size } = bbo;

    switch (type) {
      case "PRICE_ABOVE": {
        const price = side === "ASK" ? best_ask : best_bid;
        if (price === null) return { fired: false, actual_value: 0 };
        return { fired: price > threshold, actual_value: price };
      }

      case "PRICE_BELOW": {
        const price = side === "ASK" ? best_ask : best_bid;
        if (price === null) return { fired: false, actual_value: 0 };
        return { fired: price < threshold, actual_value: price };
      }

      case "SPREAD_NARROW": {
        if (best_bid === null || best_ask === null || best_ask === 0) {
          return { fired: false, actual_value: 0 };
        }
        const spreadBps = ((best_ask - best_bid) / best_ask) * 10000;
        return { fired: spreadBps < threshold, actual_value: spreadBps };
      }

      case "SPREAD_WIDE": {
        if (best_bid === null || best_ask === null || best_ask === 0) {
          return { fired: false, actual_value: 0 };
        }
        const spreadBps = ((best_ask - best_bid) / best_ask) * 10000;
        return { fired: spreadBps > threshold, actual_value: spreadBps };
      }

      case "IMBALANCE_BID": {
        if (bid_size === null || ask_size === null || (bid_size + ask_size) === 0) {
          return { fired: false, actual_value: 0 };
        }
        const imbalance = (bid_size - ask_size) / (bid_size + ask_size);
        return { fired: imbalance > threshold, actual_value: imbalance };
      }

      case "IMBALANCE_ASK": {
        if (bid_size === null || ask_size === null || (bid_size + ask_size) === 0) {
          return { fired: false, actual_value: 0 };
        }
        const imbalance = (bid_size - ask_size) / (bid_size + ask_size);
        return { fired: imbalance < -threshold, actual_value: imbalance };
      }

      case "SIZE_SPIKE": {
        const size = side === "ASK" ? ask_size : bid_size;
        if (size === null) return { fired: false, actual_value: 0 };
        return { fired: size > threshold, actual_value: size };
      }

      case "CROSSED_BOOK": {
        if (best_bid === null || best_ask === null) {
          return { fired: false, actual_value: 0 };
        }
        return { fired: best_bid >= best_ask, actual_value: best_bid - best_ask };
      }

      case "EMPTY_BOOK": {
        const isEmpty = (best_bid === null || best_bid === 0) &&
                        (best_ask === null || best_ask === 0);
        return { fired: isEmpty, actual_value: isEmpty ? 1 : 0 };
      }

      default:
        // For other trigger types, fall back to not firing
        // These would need access to historical data (priceHistory, etc.)
        return { fired: false, actual_value: 0 };
    }
  }

  /**
   * Check if the compound trigger should fire based on mode and fired count.
   */
  private checkFireCondition(
    mode: "ALL_OF" | "ANY_OF" | "N_OF_M",
    firedCount: number,
    totalConditions: number,
    threshold?: number
  ): boolean {
    switch (mode) {
      case "ALL_OF":
        return firedCount === totalConditions;
      case "ANY_OF":
        return firedCount > 0;
      case "N_OF_M":
        return firedCount >= (threshold || 1);
      default:
        return false;
    }
  }

  /**
   * Publish partial condition state for cross-shard coordination.
   */
  private async publishCrossShardState(
    trigger: CompoundTrigger,
    results: Array<{
      index: number;
      market_id: string;
      asset_id: string;
      fired: boolean;
      actual_value?: number;
    }>
  ): Promise<void> {
    if (!this.crossShardService) return;

    // Only publish conditions that belong to this shard
    for (const result of results) {
      // Check if this condition's market is on this shard
      // (This assumes conditions are pre-assigned to shards)
      await this.crossShardService.publishConditionUpdate({
        trigger_id: trigger.id,
        shard_id: this.shardId,
        condition_index: result.index,
        market_id: result.market_id,
        asset_id: result.asset_id,
        fired: result.fired,
        actual_value: result.actual_value || 0,
        timestamp: Date.now(),
        expires_at: Date.now() + 60000, // 60 second TTL
      });
    }
  }

  /**
   * Aggregate cross-shard state to determine if trigger should fire.
   */
  private async aggregateCrossShardState(
    trigger: CompoundTrigger
  ): Promise<{ shouldFire: boolean; firedConditions: number[] }> {
    if (!this.crossShardService) {
      return { shouldFire: false, firedConditions: [] };
    }

    return this.crossShardService.shouldTriggerFire(
      trigger.id,
      trigger.compound_mode,
      trigger.compound_threshold || 1,
      trigger.conditions.length
    );
  }

  /**
   * Track consecutive non-fires and emit decay signals when threshold is reached.
   *
   * When a user creates a compound trigger linking markets, they're hypothesizing
   * that those markets are related. If the trigger never fires after many evaluations,
   * the hypothesis may be wrong - we emit gentle negative signals to decay the edge.
   */
  private async trackTriggerMiss(trigger: CompoundTrigger): Promise<void> {
    const count = (this.triggerMissCount.get(trigger.id) || 0) + 1;
    this.triggerMissCount.set(trigger.id, count);

    // Only emit decay signal after sustained non-firing (every MISS_THRESHOLD evaluations)
    if (count < this.MISS_THRESHOLD || count % this.MISS_THRESHOLD !== 0) {
      return;
    }

    // No graph queue = can't emit signals
    if (!this.graphQueue) {
      return;
    }

    // Need at least 2 markets to create edge signals
    const marketIds = trigger.market_ids || trigger.conditions.map(c => c.market_id);
    if (marketIds.length < 2) {
      return;
    }

    // Emit decay signals for all market pairs in this trigger
    const pairs = allPairs(marketIds);
    const edgeType = trigger.inferred_edge_type || inferTriggerEdgeType(trigger);

    for (const [market_a, market_b] of pairs) {
      try {
        await this.graphQueue.send({
          type: "edge_signal",
          market_a,
          market_b,
          edge_type: edgeType,
          signal_source: "trigger_miss",
          user_id: trigger.user_id || "",
          strength: this.MISS_DECAY_STRENGTH, // Negative strength for decay
          metadata: {
            trigger_id: trigger.id,
            miss_count: count,
            shard_id: this.shardId,
          },
        });
      } catch (error) {
        // Log but don't fail - decay signals are not critical
        console.error(`Failed to emit decay signal for trigger ${trigger.id}:`, error);
      }
    }
  }

  /**
   * Create a CompoundTriggerEvent from evaluation results.
   */
  createTriggerEvent(
    trigger: CompoundTrigger,
    snapshot: BBOSnapshot,
    evalResult: CompoundEvaluationResult,
    sourceTs: number,
    ingestionTs: number
  ): CompoundTriggerEvent {
    const nowUs = Date.now() * 1000;

    const baseEvent: TriggerEvent = {
      trigger_id: trigger.id,
      trigger_type: trigger.conditions[0]?.type || "PRICE_ABOVE",
      market_source: trigger.market_source,
      asset_id: snapshot.asset_id,
      condition_id: snapshot.condition_id,
      fired_at: nowUs,
      total_latency_us: nowUs - sourceTs,
      processing_latency_us: nowUs - ingestionTs,
      best_bid: snapshot.best_bid,
      best_ask: snapshot.best_ask,
      bid_size: snapshot.bid_size,
      ask_size: snapshot.ask_size,
      spread_bps: snapshot.spread_bps,
      threshold: trigger.conditions[0]?.threshold || 0,
      actual_value: evalResult.conditionResults.find(r => r.fired)?.actual_value || 0,
      book_hash: snapshot.book_hash,
      sequence_number: snapshot.sequence_number,
      metadata: trigger.metadata,
    };

    return {
      ...baseEvent,
      conditions_status: evalResult.conditionResults,
      fired_conditions: evalResult.firedConditions,
      compound_mode: trigger.compound_mode,
    };
  }

  /**
   * Clear state for a specific trigger (e.g., when deleted).
   */
  clearTriggerState(triggerId: string): void {
    this.triggerState.delete(triggerId);
    this.triggerMissCount.delete(triggerId);
  }

  /**
   * Clear all stale states (called periodically).
   */
  cleanupStaleStates(): void {
    const now = Date.now();
    for (const [triggerId, state] of this.triggerState) {
      if (now - state.last_evaluation > this.STALE_STATE_THRESHOLD_MS) {
        this.triggerState.delete(triggerId);
      }
    }
  }

  /**
   * Get current state for debugging.
   */
  getState(): Map<string, CompoundTriggerState> {
    return this.triggerState;
  }

  /**
   * Get miss counts for debugging.
   */
  getMissCounts(): Map<string, number> {
    return this.triggerMissCount;
  }
}

/**
 * Determine if a compound trigger needs cross-shard coordination.
 * A trigger is cross-shard if its conditions span multiple markets
 * that are assigned to different shards.
 *
 * @param trigger - The compound trigger to check
 * @param getShardForMarket - Function to determine shard for a market
 * @returns True if the trigger spans multiple shards
 */
export function isCrossShardTrigger(
  trigger: CompoundTrigger,
  getShardForMarket: (marketId: string) => string
): boolean {
  if (trigger.conditions.length < 2) return false;

  const shards = new Set<string>();
  for (const condition of trigger.conditions) {
    shards.add(getShardForMarket(condition.market_id));
  }

  return shards.size > 1;
}

/**
 * Infer edge type from compound trigger conditions.
 * Used for graph signal emission when trigger fires.
 */
export function inferTriggerEdgeType(
  trigger: CompoundTrigger
): "correlation" | "hedge" | "causal" {
  // Check for hedge patterns (opposing price conditions)
  const hasAbove = trigger.conditions.some(c => c.type === "PRICE_ABOVE");
  const hasBelow = trigger.conditions.some(c => c.type === "PRICE_BELOW");

  if (hasAbove && hasBelow) {
    return "hedge";
  }

  // Check for causal patterns (size-based triggers)
  const hasSizeTriggers = trigger.conditions.some(c =>
    c.type === "SIZE_SPIKE" || c.type === "IMBALANCE_BID" || c.type === "IMBALANCE_ASK"
  );

  if (hasSizeTriggers) {
    return "causal";
  }

  // Default to correlation
  return "correlation";
}
