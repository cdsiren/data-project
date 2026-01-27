// src/core/enums.ts
// Core enums for the trading data framework

/**
 * Supported market sources
 */
export type MarketSource = "polymarket" | "kalshi";

/**
 * Market categories
 */
export type MarketType = "prediction";

/**
 * Instrument types
 */
export type InstrumentType = "BINARY_OPTION";

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
