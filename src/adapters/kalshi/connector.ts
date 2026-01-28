// src/adapters/kalshi/connector.ts
// Kalshi adapter stub implementing MarketConnector interface (~100 lines)
// TODO: Implement full Kalshi WebSocket integration

import type { MarketConnector, LocationHint, ParsedMarketEvent, MarketEventType } from "../base-connector";
import type { BBOSnapshot, TradeTick, OrderbookLevelChange, FullL2Snapshot } from "../../types/orderbook";

/**
 * Kalshi WebSocket connector (stub implementation).
 * Kalshi is a CFTC-regulated prediction market based in the US.
 *
 * Key differences from Polymarket:
 * - Requires authentication
 * - Different WebSocket protocol
 * - US-based servers (lower latency from enam)
 * - Different rate limits (100 assets per connection)
 */
export class KalshiConnector implements MarketConnector {
  readonly marketSource = "kalshi";
  readonly marketType = "prediction";

  private wsUrl: string;
  private apiKey?: string;

  constructor(wsUrl: string = "wss://trading-api.kalshi.com/v1/ws", apiKey?: string) {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
  }

  async connect(assets: string[]): Promise<WebSocket> {
    // TODO: Implement Kalshi authentication flow
    // Kalshi requires:
    // 1. REST API auth to get session token
    // 2. Include token in WebSocket connection
    const ws = new WebSocket(this.wsUrl);
    return ws;
  }

  disconnect(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "Client disconnect");
    }
  }

  parseMessage(data: string): ParsedMarketEvent | null {
    // TODO: Implement Kalshi message parsing
    // Kalshi message types:
    // - orderbook_snapshot: Full book
    // - orderbook_delta: Level changes
    // - trade: Trade execution
    // - subscribed: Subscription confirmation
    if (!data.startsWith("{") && !data.startsWith("[")) {
      return null; // Non-JSON, ignore
    }

    try {
      const event = JSON.parse(data) as { type: string; msg?: { market_ticker?: string } };

      const typeMap: Record<string, MarketEventType> = {
        orderbook_snapshot: "book",
        orderbook_delta: "price_change",
        trade: "trade",
      };

      const type = typeMap[event.type] || "unknown";
      const assetId = event.msg?.market_ticker;

      return { type, raw: event, assetId };
    } catch {
      return null; // Parse error
    }
  }

  normalizeBookEvent(raw: unknown): BBOSnapshot | null {
    // FAIL-FAST: Throw error to prevent silent data loss
    // Kalshi integration is not yet complete - do not use in production
    //
    // TODO: Implement Kalshi book event normalization
    // Kalshi sends orderbook updates in a different format:
    // {
    //   "type": "orderbook_snapshot",
    //   "msg": {
    //     "market_ticker": "...",
    //     "yes_bid": [[price, size], ...],
    //     "yes_ask": [[price, size], ...],
    //     "no_bid": [[price, size], ...],
    //     "no_ask": [[price, size], ...]
    //   }
    // }
    throw new Error(
      "[KalshiConnector] normalizeBookEvent not yet implemented. " +
      "Kalshi integration is incomplete - use market_source='polymarket' only."
    );
  }

  normalizeFullL2(
    raw: unknown,
    conditionId: string,
    tickSize: number,
    negRisk?: boolean,
    orderMinSize?: number
  ): FullL2Snapshot | null {
    // FAIL-FAST: Throw error to prevent silent data loss
    throw new Error(
      "[KalshiConnector] normalizeFullL2 not yet implemented. " +
      "Kalshi integration is incomplete - use market_source='polymarket' only."
    );
  }

  normalizeLevelChange(raw: unknown): OrderbookLevelChange[] | null {
    // FAIL-FAST: Throw error to prevent silent data loss
    throw new Error(
      "[KalshiConnector] normalizeLevelChange not yet implemented. " +
      "Kalshi integration is incomplete - use market_source='polymarket' only."
    );
  }

  normalizeTrade(raw: unknown): TradeTick | null {
    // FAIL-FAST: Throw error to prevent silent data loss
    // TODO: Implement Kalshi trade normalization
    // Kalshi sends trade updates in format:
    // {
    //   "type": "trade",
    //   "msg": {
    //     "market_ticker": "...",
    //     "price": 65,
    //     "count": 100,
    //     "taker_side": "yes"
    //   }
    // }
    throw new Error(
      "[KalshiConnector] normalizeTrade not yet implemented. " +
      "Kalshi integration is incomplete - use market_source='polymarket' only."
    );
  }

  getSubscriptionMessage(assets: string[]): string {
    // Kalshi uses different subscription format
    // TODO: Implement proper Kalshi subscription message
    return JSON.stringify({
      type: "subscribe",
      params: {
        channels: ["orderbook_delta"],
        market_tickers: assets,
      },
    });
  }

  getMaxAssetsPerConnection(): number {
    return 100; // Kalshi has lower limit than Polymarket
  }

  getLocationHint(): LocationHint {
    return "enam"; // Kalshi servers are in US East
  }

  getWebSocketUrl(): string {
    return this.wsUrl;
  }
}
