// src/adapters/base/websocket-handler.ts
// WebSocket handler interface for market-specific message parsing

import type { MarketSource } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";

/**
 * Parsed message types from WebSocket
 */
export type ParsedMessageType =
  | "book"          // Full orderbook snapshot
  | "price_change"  // Incremental delta
  | "trade"         // Trade execution
  | "ticker"        // Ticker update
  | "tick_size"     // Tick size change
  | "heartbeat"     // Heartbeat/ping
  | "error"         // Error message
  | "unknown";      // Unrecognized message type

/**
 * Parsed message from WebSocket
 * Contains raw market-specific data - normalization to canonical types happens downstream
 *
 * Design: Each market has different WebSocket formats. The handler parses JSON
 * and extracts routing info (instrument, type), but the actual data normalization
 * to canonical types (BBOSnapshot, TradeTick, etc.) happens in OrderbookManager
 * where the full orderbook state is available for context.
 */
export interface ParsedMessage {
  type: ParsedMessageType;
  instrument: InstrumentID;
  /** Raw market-specific data - cast to appropriate type based on market source */
  data: unknown;
  rawTimestamp?: number;
}

/**
 * Error data from WebSocket
 */
export interface ErrorData {
  code: string;
  message: string;
}

/**
 * WebSocket configuration for a market
 */
export interface WebSocketConfig {
  url: string;
  heartbeatIntervalMs: number;
  reconnectBaseDelayMs: number;
  maxReconnectDelayMs: number;
  connectionTimeoutMs: number;
  maxSubscriptionsPerConnection: number;
}

/**
 * Authentication message for WebSocket (if required)
 */
export interface AuthMessage {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * WebSocket handler interface
 * Each market implements this to handle its specific message format
 *
 * Follows CCXT pattern where parseOrderBook() normalizes exchange-specific
 * formats to a common structure
 */
export interface IWebSocketHandler {
  /** Market this handler is for */
  readonly marketSource: MarketSource;

  /**
   * Get WebSocket configuration for this market
   */
  getConfig(): WebSocketConfig;

  /**
   * Build authentication message (if market requires auth)
   *
   * @param credentials - API credentials
   * @returns Auth message to send, or null if no auth needed
   */
  buildAuthMessage(credentials: Record<string, string>): AuthMessage | null;

  /**
   * Build subscription message payload
   * Returns JSON-serializable object to send via ws.send()
   *
   * @param instruments - Instruments to subscribe to (native IDs)
   * @param channels - Channels to subscribe to
   */
  buildSubscriptionMessage(
    instruments: string[],
    channels: ("book" | "trades" | "ticker")[]
  ): unknown;

  /**
   * Build unsubscription message payload
   *
   * @param instruments - Instruments to unsubscribe from (native IDs)
   */
  buildUnsubscriptionMessage(instruments: string[]): unknown;

  /**
   * Parse incoming WebSocket message
   * Converts market-specific format → canonical format
   *
   * @param rawMessage - Raw message string from WebSocket
   * @param ingestionTs - Ingestion timestamp (microseconds)
   * @returns Array of parsed messages (may be multiple per raw message)
   */
  parseMessage(rawMessage: string, ingestionTs: number): ParsedMessage[];

  /**
   * Build heartbeat/ping message (if needed)
   *
   * @returns Heartbeat message string, or null if not needed
   */
  buildHeartbeatMessage(): string | null;

  /**
   * Detect if error message indicates rate limiting
   *
   * @param errorMessage - Error message from WebSocket
   */
  isRateLimitError(errorMessage: string): boolean;

  /**
   * Detect if error message indicates authentication failure
   *
   * @param errorMessage - Error message from WebSocket
   */
  isAuthError(errorMessage: string): boolean;

  /**
   * Get the native asset ID from a raw message (for routing)
   * Used before full parsing to determine which handler should process
   *
   * @param rawMessage - Raw message string
   * @returns Native asset ID, or null if can't determine
   */
  extractAssetId(rawMessage: string): string | null;
}

/**
 * Base class for WebSocket handlers with common functionality
 */
export abstract class BaseWebSocketHandler implements IWebSocketHandler {
  abstract readonly marketSource: MarketSource;

  abstract getConfig(): WebSocketConfig;
  abstract buildSubscriptionMessage(
    instruments: string[],
    channels: ("book" | "trades" | "ticker")[]
  ): unknown;
  abstract buildUnsubscriptionMessage(instruments: string[]): unknown;
  abstract parseMessage(rawMessage: string, ingestionTs: number): ParsedMessage[];

  buildAuthMessage(_credentials: Record<string, string>): AuthMessage | null {
    return null; // Override in subclasses that need auth
  }

  buildHeartbeatMessage(): string | null {
    return "ping"; // Default, override if different
  }

  isRateLimitError(errorMessage: string): boolean {
    const rateLimitPatterns = [
      "rate limit",
      "too many requests",
      "429",
      "throttle",
    ];
    const lowerMessage = errorMessage.toLowerCase();
    return rateLimitPatterns.some((pattern) => lowerMessage.includes(pattern));
  }

  isAuthError(errorMessage: string): boolean {
    const authPatterns = [
      "unauthorized",
      "authentication",
      "invalid api key",
      "401",
      "403",
    ];
    const lowerMessage = errorMessage.toLowerCase();
    return authPatterns.some((pattern) => lowerMessage.includes(pattern));
  }

  extractAssetId(rawMessage: string): string | null {
    try {
      const parsed = JSON.parse(rawMessage);
      return parsed.asset_id ?? parsed.symbol ?? parsed.instrument_id ?? null;
    } catch {
      return null;
    }
  }
}
