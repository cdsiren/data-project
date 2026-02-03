// src/services/trigger-evaluator/trigger-validator.ts
// Validates trigger-market compatibility at registration time

import type { TriggerType, TriggerCondition } from "../../core/triggers";
import type { MarketType } from "../../core/enums";

export interface TriggerValidationResult {
  valid: boolean;
  errors: string[];
}

/** Generic trigger types that work on all market types */
const GENERIC_TRIGGERS: Set<TriggerType> = new Set([
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
  "VOLATILITY_SPIKE",
  "MICROPRICE_DIVERGENCE",
  "IMBALANCE_SHIFT",
  "MID_PRICE_TREND",
  "QUOTE_VELOCITY",
  "STALE_QUOTE",
  "LARGE_FILL",
]);

/** Market-specific triggers */
const MARKET_SPECIFIC_TRIGGERS: Partial<Record<TriggerType, MarketType[]>> = {
  ARBITRAGE_BUY: ["prediction"],
  ARBITRAGE_SELL: ["prediction"],
  MULTI_OUTCOME_ARBITRAGE: ["prediction"],
};

/**
 * Validates trigger compatibility with market types
 */
export class TriggerValidator {
  validateForMarket(
    condition: TriggerCondition,
    marketType: MarketType
  ): TriggerValidationResult {
    const errors: string[] = [];

    // Generic triggers are allowed everywhere
    if (GENERIC_TRIGGERS.has(condition.type)) {
      return this.validateRequiredFields(condition);
    }

    // Check market-specific compatibility
    const allowedMarkets = MARKET_SPECIFIC_TRIGGERS[condition.type];
    if (!allowedMarkets) {
      return { valid: false, errors: [`Unknown trigger type: ${condition.type}`] };
    }

    if (!allowedMarkets.includes(marketType)) {
      return {
        valid: false,
        errors: [`Trigger ${condition.type} not compatible with "${marketType}". Allowed: ${allowedMarkets.join(", ")}`],
      };
    }

    const fieldValidation = this.validateRequiredFields(condition);
    if (!fieldValidation.valid) {
      errors.push(...fieldValidation.errors);
    }

    return { valid: errors.length === 0, errors };
  }

  private validateRequiredFields(condition: TriggerCondition): TriggerValidationResult {
    const errors: string[] = [];

    // Check threshold is present
    if (condition.threshold == null) {
      errors.push(`${condition.type} requires a threshold value`);
    }

    // Validate type-specific required fields
    switch (condition.type) {
      case "ARBITRAGE_BUY":
      case "ARBITRAGE_SELL":
        if (!condition.counterpart_asset_id) {
          errors.push(`${condition.type} requires counterpart_asset_id`);
        }
        break;

      case "MULTI_OUTCOME_ARBITRAGE":
        if (!condition.outcome_asset_ids || condition.outcome_asset_ids.length < 2) {
          errors.push(`${condition.type} requires outcome_asset_ids with at least 2 outcomes`);
        }
        break;

      case "PRICE_MOVE":
      case "VOLATILITY_SPIKE":
      case "IMBALANCE_SHIFT":
      case "QUOTE_VELOCITY":
        if (!condition.window_ms || condition.window_ms <= 0) {
          errors.push(`${condition.type} requires positive window_ms`);
        }
        break;
    }

    return { valid: errors.length === 0, errors };
  }

  getSupportedTriggers(marketType: MarketType): TriggerType[] {
    const supported: TriggerType[] = [...GENERIC_TRIGGERS];
    for (const [triggerType, markets] of Object.entries(MARKET_SPECIFIC_TRIGGERS)) {
      if (markets?.includes(marketType)) {
        supported.push(triggerType as TriggerType);
      }
    }
    return supported;
  }

  isCompatible(triggerType: TriggerType, marketType: MarketType): boolean {
    if (GENERIC_TRIGGERS.has(triggerType)) return true;
    const allowedMarkets = MARKET_SPECIFIC_TRIGGERS[triggerType];
    return allowedMarkets !== undefined && allowedMarkets.includes(marketType);
  }
}
