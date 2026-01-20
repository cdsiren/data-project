// src/core/instrument.ts
// Canonical instrument identification following Nautilus Trader patterns

import type { MarketSource, InstrumentType } from "./enums";

/**
 * Canonical instrument identifier
 * Format: {market}:{type}:{native_id}
 *
 * Examples:
 *   - polymarket:BINARY_OPTION:21742633143463906290569050155826241533067272736897614950488156847949938836455
 *   - kalshi:MULTI_OUTCOME:KXBTC-24JAN01-T80000
 *   - uniswap:AMM_POOL:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
 *
 * Inspired by Nautilus Trader's InstrumentId format (venue:symbol)
 */
export type InstrumentID = string;

/**
 * Parsed components of an InstrumentID
 */
export interface ParsedInstrumentID {
  market: MarketSource;
  type: InstrumentType;
  nativeId: string;
}

/**
 * Build a canonical instrument ID from components
 *
 * @param market - The market source (polymarket, kalshi, etc.)
 * @param type - The instrument type (BINARY_OPTION, SPOT, etc.)
 * @param nativeId - The market's native ID (token_id, ticker, address)
 * @returns Canonical instrument ID string
 */
export function buildInstrumentID(
  market: MarketSource,
  type: InstrumentType,
  nativeId: string
): InstrumentID {
  return `${market}:${type}:${nativeId}`;
}

/**
 * Parse a canonical instrument ID into components
 *
 * @param id - The canonical instrument ID
 * @returns Parsed components (market, type, nativeId)
 */
export function parseInstrumentID(id: InstrumentID): ParsedInstrumentID {
  const [market, type, ...rest] = id.split(":");
  return {
    market: market as MarketSource,
    type: type as InstrumentType,
    nativeId: rest.join(":"), // Handle IDs with colons (e.g., addresses)
  };
}

/**
 * Extract market source from instrument ID (fast path for routing)
 *
 * @param id - The canonical instrument ID
 * @returns Market source string
 */
export function getMarketSource(id: InstrumentID): MarketSource {
  return id.split(":")[0] as MarketSource;
}

/**
 * Extract instrument type from instrument ID
 *
 * @param id - The canonical instrument ID
 * @returns Instrument type
 */
export function getInstrumentType(id: InstrumentID): InstrumentType {
  return id.split(":")[1] as InstrumentType;
}

/**
 * Extract native ID from instrument ID
 *
 * @param id - The canonical instrument ID
 * @returns Native market ID
 */
export function getNativeId(id: InstrumentID): string {
  const parts = id.split(":");
  return parts.slice(2).join(":");
}

/**
 * Check if instrument ID is valid format
 *
 * @param id - String to validate
 * @returns True if valid instrument ID format
 */
export function isValidInstrumentID(id: string): boolean {
  const parts = id.split(":");
  if (parts.length < 3) return false;

  const validMarkets: MarketSource[] = ["polymarket", "kalshi", "uniswap", "binance"];
  const validTypes: InstrumentType[] = ["BINARY_OPTION", "MULTI_OUTCOME", "SPOT", "PERPETUAL", "AMM_POOL"];

  return (
    validMarkets.includes(parts[0] as MarketSource) &&
    validTypes.includes(parts[1] as InstrumentType) &&
    parts[2].length > 0
  );
}
