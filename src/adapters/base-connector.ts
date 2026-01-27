// src/adapters/base-connector.ts
// Lightweight adapter interface for multi-market support (~40 lines)

import type { BBOSnapshot, TradeTick, OrderbookLevelChange, FullL2Snapshot } from "../types/orderbook";

/**
 * Location hints for Durable Object placement.
 * These map to Cloudflare's regional hints for optimal latency.
 */
export type LocationHint = "weur" | "enam" | "wnam" | "apac";

/**
 * Canonical event types that all markets map to.
 * This enables market-agnostic event handling in the DO.
 */
export type MarketEventType = "book" | "price_change" | "trade" | "tick_size" | "unknown";

/**
 * Parsed market event with type and raw data.
 * The DO uses this to dispatch to appropriate handlers.
 */
export interface ParsedMarketEvent {
  type: MarketEventType;
  raw: unknown;
  assetId?: string; // For marking pending assets as confirmed
}

/**
 * Market connector interface for multi-market support.
 * Implementations normalize market-specific data formats to canonical types.
 */
export interface MarketConnector {
  /** Market source identifier (e.g., "polymarket", "kalshi") */
  readonly marketSource: string;

  /** Market type (e.g., "prediction", "dex", "cex") */
  readonly marketType: string;

  /**
   * Create a WebSocket connection to the market.
   * @param assets - List of asset IDs to subscribe to
   * @returns WebSocket instance
   */
  connect(assets: string[]): Promise<WebSocket>;

  /**
   * Disconnect and clean up WebSocket.
   * @param ws - WebSocket to disconnect
   */
  disconnect(ws: WebSocket): void;

  /**
   * Parse a raw WebSocket message and determine its event type.
   * @param data - Raw message string from WebSocket
   * @returns Parsed event with type and raw data, or null for protocol messages (PONG, etc.)
   */
  parseMessage(data: string): ParsedMarketEvent | null;

  /**
   * Normalize a raw book event to canonical BBO snapshot.
   * @param raw - Raw event from WebSocket
   * @returns Normalized snapshot or null if not applicable
   */
  normalizeBookEvent(raw: unknown): BBOSnapshot | null;

  /**
   * Normalize a raw book event to full L2 snapshot (all levels).
   * @param raw - Raw event from WebSocket
   * @param conditionId - The condition/market ID
   * @param tickSize - Tick size for the asset
   * @param negRisk - Negative risk flag
   * @param orderMinSize - Minimum order size
   * @returns Full L2 snapshot or null if not applicable
   */
  normalizeFullL2(
    raw: unknown,
    conditionId: string,
    tickSize: number,
    negRisk?: boolean,
    orderMinSize?: number
  ): FullL2Snapshot | null;

  /**
   * Normalize a raw level change to canonical format.
   * @param raw - Raw event from WebSocket
   * @returns Normalized level changes or null if not applicable
   */
  normalizeLevelChange(raw: unknown): OrderbookLevelChange[] | null;

  /**
   * Normalize a raw trade event to canonical format.
   * @param raw - Raw event from WebSocket
   * @returns Normalized trade or null if not applicable
   */
  normalizeTrade(raw: unknown): TradeTick | null;

  /**
   * Get the subscription message for the given assets.
   * @param assets - List of asset IDs to subscribe to
   * @returns JSON string to send via WebSocket
   */
  getSubscriptionMessage(assets: string[]): string;

  /**
   * Get maximum assets per WebSocket connection.
   * Markets have different rate limits.
   */
  getMaxAssetsPerConnection(): number;

  /**
   * Get optimal DO location hint for this market.
   * Based on where the market's servers are located.
   */
  getLocationHint(): LocationHint;

  /**
   * Get WebSocket URL for this market.
   */
  getWebSocketUrl(): string;
}
