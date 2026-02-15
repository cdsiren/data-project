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

// ============================================================
// CRYPTO PRICE ARB - Implied probability and fee estimation
// ============================================================

/** Default volatility: 0.1% per minute (typical for BTC in short windows) */
export const DEFAULT_VOL_PER_MINUTE = 0.001;

/**
 * Calculate the implied probability that a crypto asset will be above/below
 * a strike price at resolution, given the current external price.
 *
 * Uses a logistic approximation of the normal CDF:
 *   P(above) ≈ 1 / (1 + exp(-1.7 * zScore))
 *
 * where zScore = pctFromStrike / expectedMove
 * and expectedMove = volPerMinute * sqrt(minutesToResolution)
 *
 * @param currentPrice - Current external crypto price
 * @param strikePrice - Market strike price
 * @param direction - "ABOVE" or "BELOW"
 * @param timeToResolutionMs - Time until market resolution in ms
 * @param volPerMinute - Volatility per minute (default: 0.001 = 0.1%)
 * @returns Implied probability clamped to [0.01, 0.99]
 */
export function calculateImpliedProbability(
  currentPrice: number,
  strikePrice: number,
  direction: "ABOVE" | "BELOW",
  timeToResolutionMs: number,
  volPerMinute: number = DEFAULT_VOL_PER_MINUTE
): number {
  if (strikePrice <= 0 || currentPrice <= 0 || timeToResolutionMs <= 0) {
    return 0.5;
  }

  const minutesToResolution = timeToResolutionMs / 60000;
  const expectedMove = volPerMinute * Math.sqrt(minutesToResolution);

  // Percentage distance from strike (positive = above strike)
  const pctFromStrike = (currentPrice - strikePrice) / strikePrice;

  // Avoid division by zero
  if (expectedMove <= 0) {
    const aboveProb = pctFromStrike > 0 ? 0.99 : pctFromStrike < 0 ? 0.01 : 0.5;
    return direction === "ABOVE" ? aboveProb : 1 - aboveProb;
  }

  const zScore = pctFromStrike / expectedMove;

  // Logistic approximation of normal CDF: P(above) ≈ 1 / (1 + exp(-1.7 * z))
  const probAbove = 1 / (1 + Math.exp(-1.7 * zScore));

  const prob = direction === "ABOVE" ? probAbove : 1 - probAbove;

  // Clamp to [0.01, 0.99]
  return Math.max(0.01, Math.min(0.99, prob));
}

/**
 * Estimate Polymarket fees for a crypto price market trade.
 *
 * Fee structure:
 * - Polymarket charges ~2% on winnings (effective fee depends on probability)
 * - For short-duration markets, the fee impact is higher relative to edge
 * - We use a conservative flat estimate based on time-to-resolution
 *
 * @param timeToResolutionMs - Time until market resolution in ms
 * @returns Estimated fee in basis points
 */
export function estimatePolymarketFees(timeToResolutionMs: number): number {
  // Base fee: ~200 bps (2% of winnings, roughly)
  // Short-duration markets have higher effective fees due to probability compression
  const baseFee = 200;

  // Add urgency premium for very short-duration windows
  // Under 5 minutes: extra 50 bps for slippage/execution risk
  if (timeToResolutionMs < 5 * 60 * 1000) {
    return baseFee + 50;
  }

  return baseFee;
}
