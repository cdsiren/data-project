// src/adapters/kalshi/connector.ts
// Kalshi adapter stub implementing MarketConnector interface (~100 lines)
// TODO: Implement full Kalshi WebSocket integration

import type { MarketConnector, LocationHint } from "../base-connector";
import type { BBOSnapshot, TradeTick, OrderbookLevelChange } from "../../types/orderbook";

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

  normalizeBookEvent(raw: unknown): BBOSnapshot | null {
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
    console.warn("[KalshiConnector] normalizeBookEvent not implemented");
    return null;
  }

  normalizeLevelChange(raw: unknown): OrderbookLevelChange[] | null {
    // TODO: Implement Kalshi level change normalization
    console.warn("[KalshiConnector] normalizeLevelChange not implemented");
    return null;
  }

  normalizeTrade(raw: unknown): TradeTick | null {
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
    console.warn("[KalshiConnector] normalizeTrade not implemented");
    return null;
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
