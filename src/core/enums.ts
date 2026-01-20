// src/core/enums.ts
// Market-agnostic enums for the multi-market trading framework

/**
 * Supported market sources (exchanges/platforms)
 * Add new markets here as they're integrated
 */
export type MarketSource = "polymarket" | "kalshi" | "uniswap" | "binance";

/**
 * Market categories for grouping similar markets
 * Used for shared types and trigger logic
 */
export type MarketType = "prediction" | "dex" | "cex";

/**
 * Instrument types across all markets
 * Determines applicable triggers and normalization logic
 */
export type InstrumentType =
  | "BINARY_OPTION"   // Polymarket YES/NO, Kalshi binary
  | "MULTI_OUTCOME"   // Kalshi multi-outcome events
  | "SPOT"            // DEX/CEX spot pairs
  | "PERPETUAL"       // Perp futures
  | "AMM_POOL";       // Uniswap LP pools

/**
 * Order side (consistent across all markets)
 */
export type OrderSide = "BUY" | "SELL";

/**
 * Tick direction for market microstructure analysis
 */
export type TickDirection = "UP" | "DOWN" | "UNCHANGED";

/**
 * Order book level change types
 */
export type LevelChangeType = "ADD" | "REMOVE" | "UPDATE";
