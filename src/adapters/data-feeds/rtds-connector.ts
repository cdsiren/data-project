// src/adapters/data-feeds/rtds-connector.ts
// Polymarket RTDS (Real-Time Data Service) adapter
// Uses web-standard WebSocket (compatible with Cloudflare Workers)
// Ref: https://github.com/Polymarket/real-time-data-client/blob/main/src/client.ts

/**
 * Supported RTDS crypto symbols (Binance source).
 * RTDS uses lowercase symbol format (e.g., "btcusdt" not "BTCUSDT").
 */
export const RTDS_SUPPORTED_SYMBOLS = [
  "btcusdt",
  "ethusdt",
  "solusdt",
  "xrpusdt",
  "dogeusdt",
] as const;

export type RTDSSymbol = (typeof RTDS_SUPPORTED_SYMBOLS)[number];

export interface RTDSMessage {
  symbol: string;
  value: number;
  timestamp: number; // ms
  source: string;
}

/**
 * RTDS connector for Polymarket's real-time crypto price feed.
 *
 * Wire protocol (per official real-time-data-client + docs):
 * - Host: wss://ws-live-data.polymarket.com
 * - Subscribe: { action: "subscribe", subscriptions: [{ topic, type, filters }] }
 *   - Binance: topic="crypto_prices", type="update", filters="solusdt,btcusdt,..."
 * - Messages: { topic: "crypto_prices", type: "update", timestamp, payload: { symbol, value, timestamp } }
 * - Keepalive: send "ping" every 5s, server responds with pong
 */
export class RTDSConnector {
  private readonly wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  getWebSocketUrl(): string {
    return this.wsUrl;
  }

  getSubscriptionMessage(): string {
    return JSON.stringify({
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices",
          type: "update",
          filters: RTDS_SUPPORTED_SYMBOLS.join(","),
        },
      ],
    });
  }

  parseMessage(data: string): RTDSMessage | null {
    // Skip non-JSON messages (pong responses)
    if (!data.includes("payload")) return null;

    try {
      const msg = JSON.parse(data);

      // Skip non-crypto-price messages (subscription confirmations, etc.)
      if (!msg.payload || msg.topic !== "crypto_prices") {
        return null;
      }

      const { symbol, value, timestamp } = msg.payload;
      if (!symbol || value == null || !timestamp) {
        return null;
      }

      return {
        symbol: String(symbol).toLowerCase(),
        value: Number(value),
        timestamp: Number(timestamp),
        source: "binance",
      };
    } catch {
      return null;
    }
  }
}
