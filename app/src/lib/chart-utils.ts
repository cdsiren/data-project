import type { OHLCData } from "@/types";
import type { CandlestickData, Time } from "lightweight-charts";
import { logger } from "./logger";

const EMPTY_ARRAY: CandlestickData<Time>[] = [];

/**
 * Validate and transform a single OHLC candle
 */
function transformCandle(candle: OHLCData): CandlestickData<Time> | null {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (
    isNaN(open) ||
    isNaN(high) ||
    isNaN(low) ||
    isNaN(close) ||
    open <= 0 ||
    close <= 0
  ) {
    return null;
  }

  // Validate OHLC consistency
  if (high < low || open > high || open < low || close > high || close < low) {
    logger.warn("Chart", "Invalid OHLC values:", candle);
    return null;
  }

  return {
    time: Math.floor(Number(candle.time) / 1000) as Time,
    open,
    high,
    low,
    close,
  };
}

/**
 * Transform API OHLC data to Lightweight Charts format with validation
 */
export function transformToChartData(
  data: OHLCData[] | undefined
): CandlestickData<Time>[] {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return EMPTY_ARRAY;
  }

  const transformed: CandlestickData<Time>[] = [];

  for (const candle of data) {
    const result = transformCandle(candle);
    if (result !== null) {
      transformed.push(result);
    }
  }

  logger.debug("Chart", "Transformed", transformed.length, "of", data.length, "candles");

  return transformed;
}

/**
 * Format price for prediction markets (0-1 range, show as cents)
 */
export function formatPrice(price: number | null): string {
  if (price === null) return "-";
  return `${(price * 100).toFixed(1)}¢`;
}

/**
 * Format spread in basis points
 */
export function formatSpread(bps: number | null): string {
  if (bps === null) return "-";
  return `${bps.toFixed(0)} bps`;
}

/**
 * Format timestamp to readable time
 */
export function formatTime(timestamp: number): string {
  const ms = timestamp > 1e12 ? timestamp / 1000 : timestamp;
  return new Date(ms).toLocaleTimeString();
}

/**
 * Format latency in microseconds to readable format with validation
 */
export function formatLatency(latencyUs: number | null | undefined): string {
  if (latencyUs == null || isNaN(latencyUs)) return "-";
  if (latencyUs < 0) return "-"; // Invalid (clock skew or calculation error)
  if (latencyUs < 1000) return `${latencyUs.toFixed(0)}μs`;
  return `${(latencyUs / 1000).toFixed(1)}ms`;
}
