// src/adapters/polymarket/websocket-handler.ts
// Polymarket WebSocket message parser

import type { MarketSource } from "../../core/enums";
import {
  BaseWebSocketHandler,
  type WebSocketConfig,
  type ParsedMessage,
  type ParsedMessageType,
} from "../base/websocket-handler";
import type {
  PolymarketWSEvent,
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
  PolymarketTickSizeChangeEvent,
} from "./types";
import { buildPolymarketInstrumentID } from "./normalizers";

/**
 * Raw parsed data from Polymarket WebSocket
 * Before normalization to canonical types
 */
export interface PolymarketParsedData {
  eventType: string;
  assetId: string;
  conditionId: string;
  timestamp: number;
  rawEvent: PolymarketWSEvent;
}

/**
 * Polymarket WebSocket handler
 * Parses Polymarket-specific WebSocket messages into canonical format
 */
export class PolymarketWebSocketHandler extends BaseWebSocketHandler {
  readonly marketSource: MarketSource = "polymarket";

  private wsUrl: string;
  private heartbeatIntervalMs: number;
  private maxSubscriptionsPerConnection: number;

  constructor(
    wsUrl: string = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    heartbeatIntervalMs: number = 10000,
    maxSubscriptionsPerConnection: number = 500
  ) {
    super();
    this.wsUrl = wsUrl;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxSubscriptionsPerConnection = maxSubscriptionsPerConnection;
  }

  getConfig(): WebSocketConfig {
    return {
      url: this.wsUrl,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      reconnectBaseDelayMs: 1000,
      maxReconnectDelayMs: 30000,
      connectionTimeoutMs: 15000,
      maxSubscriptionsPerConnection: this.maxSubscriptionsPerConnection,
    };
  }

  /**
   * Build Polymarket subscription message
   * Format: { assets_ids: [...], type: "market" }
   */
  buildSubscriptionMessage(
    instruments: string[],
    _channels: ("book" | "trades" | "ticker")[]
  ): unknown {
    return {
      assets_ids: instruments,
      type: "market",
    };
  }

  /**
   * Polymarket doesn't have explicit unsubscribe - close and reconnect
   */
  buildUnsubscriptionMessage(_instruments: string[]): unknown {
    // Polymarket requires closing the connection to unsubscribe
    return null;
  }

  /**
   * Parse incoming Polymarket WebSocket message
   * Converts Polymarket-specific format to canonical ParsedMessage
   */
  parseMessage(rawMessage: string, ingestionTs: number): ParsedMessage[] {
    // Handle non-JSON protocol messages
    if (rawMessage === "PONG") {
      return []; // Expected heartbeat response, ignore
    }

    if (rawMessage === "INVALID OPERATION") {
      return [{
        type: "error",
        instrument: "",
        data: { code: "INVALID_OPERATION", message: "Polymarket rejected the subscription" },
      }];
    }

    // Skip non-JSON messages
    if (!rawMessage.startsWith("{") && !rawMessage.startsWith("[")) {
      console.warn(`[PolymarketWS] Unexpected non-JSON message: "${rawMessage.slice(0, 100)}"`);
      return [];
    }

    try {
      const event = JSON.parse(rawMessage) as PolymarketWSEvent;
      return this.parseEvent(event, ingestionTs);
    } catch (error) {
      console.error(`[PolymarketWS] JSON parse error: ${error}`);
      return [{
        type: "error",
        instrument: "",
        data: { code: "PARSE_ERROR", message: String(error) },
      }];
    }
  }

  /**
   * Parse a single Polymarket event into canonical format(s)
   */
  private parseEvent(event: PolymarketWSEvent, ingestionTs: number): ParsedMessage[] {
    const messages: ParsedMessage[] = [];

    switch (event.event_type) {
      case "book":
        messages.push(this.parseBookEvent(event, ingestionTs));
        break;

      case "price_change":
        // price_change can contain multiple assets
        messages.push(...this.parsePriceChangeEvent(event, ingestionTs));
        break;

      case "last_trade_price":
        messages.push(this.parseTradeEvent(event, ingestionTs));
        break;

      case "tick_size_change":
        messages.push(this.parseTickSizeEvent(event, ingestionTs));
        break;

      default:
        console.warn(`[PolymarketWS] Unknown event type: ${(event as { event_type: string }).event_type}`);
        messages.push({
          type: "unknown",
          instrument: "",
          data: null,
        });
    }

    return messages;
  }

  /**
   * Parse book event (full orderbook snapshot)
   */
  private parseBookEvent(event: PolymarketBookEvent, _ingestionTs: number): ParsedMessage {
    return {
      type: "book",
      instrument: buildPolymarketInstrumentID(event.asset_id),
      data: event, // Return raw event - normalization happens in OrderbookManager
      rawTimestamp: parseInt(event.timestamp),
    };
  }

  /**
   * Parse price_change event (incremental updates)
   * Note: A single price_change event can contain updates for multiple assets
   */
  private parsePriceChangeEvent(event: PolymarketPriceChangeEvent, _ingestionTs: number): ParsedMessage[] {
    // Group changes by asset_id
    const assetIds = new Set<string>();
    for (const change of event.price_changes) {
      if (change.asset_id) {
        assetIds.add(change.asset_id);
      }
    }

    // Create a message for each affected asset
    return Array.from(assetIds).map((assetId) => ({
      type: "price_change" as ParsedMessageType,
      instrument: buildPolymarketInstrumentID(assetId),
      data: event, // Return full event - filtering happens in OrderbookManager
      rawTimestamp: parseInt(event.timestamp),
    }));
  }

  /**
   * Parse trade event
   */
  private parseTradeEvent(event: PolymarketLastTradePriceEvent, _ingestionTs: number): ParsedMessage {
    return {
      type: "trade",
      instrument: buildPolymarketInstrumentID(event.asset_id),
      data: event,
      rawTimestamp: parseInt(event.timestamp),
    };
  }

  /**
   * Parse tick size change event
   */
  private parseTickSizeEvent(event: PolymarketTickSizeChangeEvent, _ingestionTs: number): ParsedMessage {
    return {
      type: "tick_size",
      instrument: buildPolymarketInstrumentID(event.asset_id),
      data: event,
      rawTimestamp: parseInt(event.timestamp),
    };
  }

  /**
   * Build Polymarket heartbeat message
   */
  buildHeartbeatMessage(): string {
    return "PING";
  }

  /**
   * Check if error indicates rate limiting
   */
  isRateLimitError(errorMessage: string): boolean {
    const patterns = [
      "rate limit",
      "too many requests",
      "429",
      "throttle",
      "INVALID OPERATION", // Polymarket-specific rate limit indicator
    ];
    const lower = errorMessage.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  /**
   * Extract asset ID from raw message for routing
   */
  extractAssetId(rawMessage: string): string | null {
    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed.asset_id) {
        return parsed.asset_id;
      }
      // For price_change events, get first asset_id from changes
      if (parsed.price_changes && parsed.price_changes.length > 0) {
        return parsed.price_changes[0].asset_id;
      }
      return null;
    } catch {
      return null;
    }
  }
}
