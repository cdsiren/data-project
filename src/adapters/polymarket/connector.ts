// src/adapters/polymarket/connector.ts
// Polymarket adapter implementing MarketConnector interface (~150 lines)

import type { MarketConnector, LocationHint } from "../base-connector";
import type { BBOSnapshot, TradeTick, OrderbookLevelChange } from "../../types/orderbook";
import type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
} from "./types";

/**
 * Polymarket WebSocket connector.
 * Normalizes Polymarket-specific data formats to canonical types.
 */
export class PolymarketConnector implements MarketConnector {
  readonly marketSource = "polymarket";
  readonly marketType = "prediction";

  private wsUrl: string;

  constructor(wsUrl: string = "wss://ws-subscriptions-clob.polymarket.com/ws/market") {
    this.wsUrl = wsUrl;
  }

  async connect(assets: string[]): Promise<WebSocket> {
    const ws = new WebSocket(this.wsUrl);
    return ws;
  }

  disconnect(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "Client disconnect");
    }
  }

  normalizeBookEvent(raw: unknown): BBOSnapshot | null {
    const event = raw as PolymarketBookEvent;
    if (!event || event.event_type !== "book") return null;

    const sourceTs = parseInt(event.timestamp);
    const ingestionTs = Date.now() * 1000; // Microseconds

    // Parse levels
    const bids = event.bids.map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = event.asks.map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    // Polymarket returns bids ASCENDING (lowest first) and asks DESCENDING (highest first)
    // Best bid = HIGHEST bid price, Best ask = LOWEST ask price
    const bestBidLevel = bids.length > 0
      ? bids.reduce((best, curr) => curr.price > best.price ? curr : best)
      : null;
    const bestAskLevel = asks.length > 0
      ? asks.reduce((best, curr) => curr.price < best.price ? curr : best)
      : null;

    const bestBid = bestBidLevel?.price ?? null;
    const bestAsk = bestAskLevel?.price ?? null;
    const midPrice = bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : null;
    const spreadBps = bestBid !== null && bestAsk !== null && midPrice !== null && midPrice > 0
      ? ((bestAsk - bestBid) / midPrice) * 10000
      : null;

    return {
      market_source: this.marketSource as "polymarket",
      market_type: this.marketType,
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: event.market,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      book_hash: event.hash,
      sequence_number: 1,
      is_resync: false,
      best_bid: bestBid,
      best_ask: bestAsk,
      bid_size: bestBidLevel?.size ?? null,
      ask_size: bestAskLevel?.size ?? null,
      mid_price: midPrice,
      spread_bps: spreadBps,
      tick_size: 0.01, // Default, should be overridden from market config
    };
  }

  normalizeLevelChange(raw: unknown): OrderbookLevelChange[] | null {
    const event = raw as PolymarketPriceChangeEvent;
    if (!event || event.event_type !== "price_change") return null;

    const sourceTs = parseInt(event.timestamp);
    const ingestionTs = Date.now() * 1000;

    return event.price_changes.map((change) => ({
      market_source: this.marketSource as "polymarket",
      market_type: this.marketType,
      asset_id: change.asset_id,
      condition_id: event.market,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      side: change.side as "BUY" | "SELL",
      price: parseFloat(change.price),
      old_size: 0, // Would need local book state to determine
      new_size: parseFloat(change.size),
      size_delta: parseFloat(change.size), // Simplified
      change_type: parseFloat(change.size) > 0 ? "ADD" : "REMOVE",
      book_hash: change.hash || "",
      sequence_number: 0, // Would need local state
    }));
  }

  normalizeTrade(raw: unknown): TradeTick | null {
    const event = raw as PolymarketLastTradePriceEvent;
    if (!event || event.event_type !== "last_trade_price") return null;

    const sourceTs = parseInt(event.timestamp);
    const ingestionTs = Date.now() * 1000;

    return {
      market_source: this.marketSource as "polymarket",
      market_type: this.marketType,
      asset_id: event.asset_id,
      condition_id: event.market,
      trade_id: `${event.asset_id}-${sourceTs}-${crypto.randomUUID().slice(0, 8)}`,
      price: parseFloat(event.price),
      size: parseFloat(event.size),
      side: event.side,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
    };
  }

  getSubscriptionMessage(assets: string[]): string {
    return JSON.stringify({
      assets_ids: assets,
      type: "market",
    });
  }

  getMaxAssetsPerConnection(): number {
    return 450; // Polymarket allows 500, use 450 for headroom
  }

  getLocationHint(): LocationHint {
    return "weur"; // Polymarket servers are in London (eu-west-2)
  }

  getWebSocketUrl(): string {
    return this.wsUrl;
  }
}
