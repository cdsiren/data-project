// src/adapters/polymarket/connector.ts
// Polymarket adapter implementing MarketConnector interface (~150 lines)

import type { MarketConnector, LocationHint, ParsedMarketEvent, MarketEventType } from "../base-connector";
import type { BBOSnapshot, TradeTick, OrderbookLevelChange, FullL2Snapshot } from "../../types/orderbook";
import type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
  PolymarketWSEvent,
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

  parseMessage(data: string): ParsedMarketEvent | null {
    // Handle Polymarket protocol messages
    if (data === "PONG") {
      return null; // Heartbeat response, ignore
    }
    if (data === "INVALID OPERATION") {
      return { type: "unknown", raw: data }; // Will be handled specially by DO
    }
    if (!data.startsWith("{") && !data.startsWith("[")) {
      return null; // Non-JSON, ignore
    }

    try {
      const event = JSON.parse(data) as PolymarketWSEvent;

      // Map Polymarket event types to canonical types
      const typeMap: Record<string, MarketEventType> = {
        book: "book",
        price_change: "price_change",
        last_trade_price: "trade",
        tick_size_change: "tick_size",
      };

      const type = typeMap[event.event_type] || "unknown";
      const assetId = "asset_id" in event ? event.asset_id : undefined;

      return { type, raw: event, assetId };
    } catch {
      return null; // Parse error
    }
  }

  normalizeBookEvent(raw: unknown): BBOSnapshot | null {
    const event = raw as PolymarketBookEvent;
    if (!event || event.event_type !== "book") return null;

    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs
    // Note: ingestion_ts is set to 0 here because it's always overridden
    // by the DO with the actual WebSocket receive timestamp

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
    // Best bid = last element (highest), Best ask = last element (lowest)
    // O(1) direct access instead of O(n) reduce
    const bestBidLevel = bids.length > 0 ? bids[bids.length - 1] : null;
    const bestAskLevel = asks.length > 0 ? asks[asks.length - 1] : null;

    const bestBid = bestBidLevel?.price ?? null;
    const bestAsk = bestAskLevel?.price ?? null;

    // Calculate derived metrics - single null check, no redundant conditions
    let midPrice: number | null = null;
    let spreadBps: number | null = null;
    if (bestBid !== null && bestAsk !== null) {
      midPrice = (bestBid + bestAsk) / 2;
      if (midPrice > 0) {
        spreadBps = ((bestAsk - bestBid) / midPrice) * 10000;
      }
    }

    return {
      market_source: this.marketSource as "polymarket",
      market_type: this.marketType,
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: event.market,
      source_ts: sourceTs,
      ingestion_ts: 0, // Placeholder - always overridden by DO with actual receive timestamp
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

  normalizeFullL2(
    raw: unknown,
    conditionId: string,
    tickSize: number,
    negRisk?: boolean,
    orderMinSize?: number
  ): FullL2Snapshot | null {
    const event = raw as PolymarketBookEvent;
    if (!event || event.event_type !== "book") return null;

    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs

    // Parse all levels
    const bids = event.bids.map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = event.asks.map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    return {
      market_source: this.marketSource as "polymarket",
      asset_id: event.asset_id,
      token_id: event.asset_id,
      condition_id: conditionId || event.market,
      source_ts: sourceTs,
      ingestion_ts: 0, // Placeholder - always overridden by DO with actual receive timestamp
      book_hash: event.hash,
      bids,
      asks,
      tick_size: tickSize,
      sequence_number: 1,
      neg_risk: negRisk,
      order_min_size: orderMinSize,
    };
  }

  normalizeLevelChange(raw: unknown): OrderbookLevelChange[] | null {
    const event = raw as PolymarketPriceChangeEvent;
    if (!event || event.event_type !== "price_change") return null;

    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs

    return event.price_changes.map((change) => ({
      market_source: this.marketSource as "polymarket",
      market_type: this.marketType,
      asset_id: change.asset_id,
      condition_id: event.market,
      source_ts: sourceTs,
      ingestion_ts: 0, // Placeholder - always overridden by DO with actual receive timestamp
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

    const sourceTs = parseInt(event.timestamp) * 1000; // Convert ms to μs

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
      ingestion_ts: 0, // Placeholder - always overridden by DO with actual receive timestamp
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
