// src/utils/arbitrage-calculations.ts
// Shared utility for arbitrage trade sizing calculations
// Used by both orderbook-manager.ts and prediction-evaluator.ts

/**
 * Constants for arbitrage detection
 */
export const STALE_DATA_THRESHOLD_MS = 5000; // 5 seconds
export const STALE_DATA_THRESHOLD_US = STALE_DATA_THRESHOLD_MS * 1000; // 5,000,000 microseconds

/**
 * Parameters for arbitrage sizing calculation
 */
export interface ArbitrageSizingParams {
  /** Size available on primary asset side (shares/contracts) */
  primarySize: number | null;
  /** Size available on counterpart asset side (shares/contracts) */
  counterpartSize: number | null;
  /** Total price (sum of asks for buy, sum of bids for sell) */
  priceSum: number;
  /** Profit per share (1 - sumOfAsks for buy, sumOfBids - 1 for sell) */
  profitPerShare: number;
}

/**
 * Result of arbitrage sizing calculation
 */
export interface ArbitrageSizingResult {
  /** Maximum executable size (min of both sides). Units: shares/contracts */
  recommended_size: number;
  /** Total capital required/received. Units: dollars */
  max_notional: number;
  /** Expected profit before fees. Units: dollars */
  expected_profit: number;
}

/**
 * Calculate trade sizing metrics for arbitrage opportunities
 *
 * @param params - Sizing parameters including sizes, price sum, and profit per share
 * @returns Trade sizing metrics
 *
 * @example
 * // ARBITRAGE_BUY: buying YES and NO at ask prices
 * const sizing = calculateArbitrageSizing({
 *   primarySize: snapshot.ask_size,
 *   counterpartSize: counterpartBBO.ask_size,
 *   priceSum: sumOfAsks,
 *   profitPerShare: 1 - sumOfAsks,
 * });
 *
 * @example
 * // ARBITRAGE_SELL: selling YES and NO at bid prices
 * const sizing = calculateArbitrageSizing({
 *   primarySize: snapshot.bid_size,
 *   counterpartSize: counterpartBBO.bid_size,
 *   priceSum: sumOfBids,
 *   profitPerShare: sumOfBids - 1,
 * });
 *
 * @remarks
 * - Returns recommended_size of 0 if either side has no liquidity (null or 0)
 * - A zero-size result indicates the arbitrage exists but cannot be exploited
 * - Callers should check recommended_size > 0 before executing trades
 */
export function calculateArbitrageSizing(
  params: ArbitrageSizingParams
): ArbitrageSizingResult {
  const primarySize = params.primarySize ?? 0;
  const counterpartSize = params.counterpartSize ?? 0;
  const recommendedSize = Math.min(primarySize, counterpartSize);

  return {
    recommended_size: recommendedSize,
    max_notional: recommendedSize * params.priceSum,
    expected_profit: recommendedSize * params.profitPerShare,
  };
}

/**
 * Check if two timestamps are within the stale data threshold
 *
 * @param ts1 - First timestamp in microseconds
 * @param ts2 - Second timestamp in microseconds
 * @param thresholdUs - Maximum allowed difference in microseconds (default: 5 seconds)
 * @returns true if data is fresh (within threshold), false if stale
 *
 * @example
 * if (!isTimestampFresh(snapshot.source_ts, counterpartBBO.ts)) {
 *   // Data is stale, skip arbitrage evaluation
 *   return;
 * }
 */
export function isTimestampFresh(
  ts1: number,
  ts2: number,
  thresholdUs: number = STALE_DATA_THRESHOLD_US
): boolean {
  return Math.abs(ts1 - ts2) <= thresholdUs;
}
