// src/services/crypto-market-parser.ts
// Parses Polymarket crypto price market questions into structured metadata

import { RTDS_SUPPORTED_SYMBOLS } from "../adapters/data-feeds/rtds-connector";

/**
 * Structured metadata extracted from a crypto price prediction market
 */
export interface CryptoPriceMarketInfo {
  /** RTDS symbol (e.g., "btcusdt") */
  symbol: string;
  /** Strike price in USD */
  strikePrice: number;
  /** Market direction */
  direction: "ABOVE" | "BELOW";
  /** Resolution time as Unix ms timestamp */
  resolutionTime: number;
}

/**
 * Map of crypto name variations to RTDS symbols.
 * RTDS uses lowercase symbols (e.g., "btcusdt" not "BTCUSDT").
 * Covers common variations found in Polymarket question titles.
 */
const CRYPTO_NAME_TO_SYMBOL: Record<string, string> = {
  BTC: "btcusdt",
  BITCOIN: "btcusdt",
  ETH: "ethusdt",
  ETHEREUM: "ethusdt",
  ETHER: "ethusdt",
  SOL: "solusdt",
  SOLANA: "solusdt",
  XRP: "xrpusdt",
  RIPPLE: "xrpusdt",
  DOGE: "dogeusdt",
  DOGECOIN: "dogeusdt",
};

// Set of valid RTDS symbols for fast lookup
const VALID_SYMBOLS = new Set<string>(RTDS_SUPPORTED_SYMBOLS);

/**
 * Regex patterns for Polymarket crypto price market questions.
 *
 * Examples:
 * - "Will BTC be above $100,000 at 2:00 PM ET?"
 * - "Will Bitcoin be below $95,500.50 at 3:30 PM ET?"
 * - "Will ETH be above $3,000 at 12:00 PM ET on Feb 14?"
 * - "Will SOL go above $200 by 2:00 PM ET?"
 */
const CRYPTO_PRICE_PATTERNS = [
  // "Will BTC be above/below $100,000 at ..."
  /will\s+(\w+)\s+(?:be\s+)?(above|below)\s+\$?([\d,]+(?:\.\d+)?)/i,
  // "Will BTC go above/below $100,000 ..."
  /will\s+(\w+)\s+go\s+(above|below)\s+\$?([\d,]+(?:\.\d+)?)/i,
  // "Will the price of BTC be above/below ..."
  /will\s+(?:the\s+)?price\s+of\s+(\w+)\s+(?:be\s+)?(above|below)\s+\$?([\d,]+(?:\.\d+)?)/i,
];

/**
 * Parse a Polymarket crypto market question into structured metadata.
 *
 * @param question - The market question string
 * @param endDate - ISO string or Unix ms timestamp of market resolution
 * @returns Parsed market info, or null if not a recognized crypto price market
 */
export function parseCryptoMarket(
  question: string,
  endDate: string | number
): CryptoPriceMarketInfo | null {
  for (const pattern of CRYPTO_PRICE_PATTERNS) {
    const match = question.match(pattern);
    if (!match) continue;

    const [, cryptoName, direction, priceStr] = match;

    // Resolve crypto name to RTDS symbol
    const symbol = CRYPTO_NAME_TO_SYMBOL[cryptoName.toUpperCase()];
    if (!symbol || !VALID_SYMBOLS.has(symbol)) continue;

    // Parse strike price (remove commas)
    const strikePrice = parseFloat(priceStr.replace(/,/g, ""));
    if (isNaN(strikePrice) || strikePrice <= 0) continue;

    // Parse resolution time
    const resolutionTime =
      typeof endDate === "number"
        ? endDate
        : new Date(endDate).getTime();

    if (isNaN(resolutionTime)) continue;

    return {
      symbol,
      strikePrice,
      direction: direction.toUpperCase() as "ABOVE" | "BELOW",
      resolutionTime,
    };
  }

  return null;
}
