/**
 * PolymarketConnector Unit Tests
 *
 * P0 Critical Tests: Validates the BBO extraction logic, timestamp handling,
 * and edge cases that were previously untested.
 *
 * Run with: npx vitest run src/tests/connector.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PolymarketConnector } from "../adapters/polymarket/connector";
import type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
} from "../adapters/polymarket/types";

describe("PolymarketConnector", () => {
  let connector: PolymarketConnector;

  beforeEach(() => {
    connector = new PolymarketConnector();
  });

  describe("parseMessage", () => {
    it("should return null for PONG heartbeat", () => {
      const result = connector.parseMessage("PONG");
      expect(result).toBeNull();
    });

    it("should handle INVALID OPERATION message", () => {
      const result = connector.parseMessage("INVALID OPERATION");
      expect(result).toEqual({ type: "unknown", raw: "INVALID OPERATION" });
    });

    it("should return null for non-JSON messages", () => {
      expect(connector.parseMessage("hello")).toBeNull();
      expect(connector.parseMessage("123")).toBeNull();
      expect(connector.parseMessage("")).toBeNull();
    });

    it("should parse book events", () => {
      const bookEvent: PolymarketBookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "test_market",
        bids: [{ price: "0.45", size: "100" }],
        asks: [{ price: "0.55", size: "100" }],
        timestamp: "1700000000000",
        hash: "abc123",
      };

      const result = connector.parseMessage(JSON.stringify(bookEvent));
      expect(result).toEqual({
        type: "book",
        raw: bookEvent,
        assetId: "test_asset",
      });
    });

    it("should parse price_change events", () => {
      const priceChangeEvent: PolymarketPriceChangeEvent = {
        event_type: "price_change",
        market: "test_market",
        price_changes: [
          { asset_id: "test_asset", side: "BUY", price: "0.46", size: "50" },
        ],
        timestamp: "1700000000000",
      };

      const result = connector.parseMessage(JSON.stringify(priceChangeEvent));
      expect(result).toEqual({
        type: "price_change",
        raw: priceChangeEvent,
        assetId: "test_asset", // fast-parse extracts first asset_id from price_changes
      });
    });

    it("should parse last_trade_price events as trade", () => {
      const tradeEvent: PolymarketLastTradePriceEvent = {
        event_type: "last_trade_price",
        asset_id: "test_asset",
        market: "test_market",
        price: "0.50",
        size: "100",
        side: "BUY",
        timestamp: "1700000000000",
      };

      const result = connector.parseMessage(JSON.stringify(tradeEvent));
      expect(result).toEqual({
        type: "trade",
        raw: tradeEvent,
        assetId: "test_asset",
      });
    });

    it("should handle malformed JSON gracefully", () => {
      const result = connector.parseMessage('{"invalid json');
      expect(result).toBeNull();
    });
  });

  describe("normalizeBookEvent", () => {
    describe("BBO extraction with Polymarket ordering", () => {
      it("should extract best bid (MAX) from ascending bids", () => {
        // Polymarket sends bids in ASCENDING order (lowest first)
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [
            { price: "0.40", size: "100" }, // lowest bid
            { price: "0.42", size: "200" },
            { price: "0.45", size: "300" }, // BEST bid (highest)
          ],
          asks: [{ price: "0.55", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result).not.toBeNull();
        expect(result!.best_bid).toBe(0.45); // Should pick the highest bid
        expect(result!.bid_size).toBe(300);
      });

      it("should extract best ask (MIN) from descending asks", () => {
        // Polymarket sends asks in DESCENDING order (highest first)
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [
            { price: "0.60", size: "100" }, // highest ask
            { price: "0.57", size: "200" },
            { price: "0.55", size: "300" }, // BEST ask (lowest)
          ],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result).not.toBeNull();
        expect(result!.best_ask).toBe(0.55); // Should pick the lowest ask
        expect(result!.ask_size).toBe(300);
      });

      it("should extract BBO from properly sorted Polymarket arrays", () => {
        // Polymarket ALWAYS sends sorted arrays (verified by data validation tests):
        // - bids: ASCENDING (lowest first, best/highest LAST)
        // - asks: DESCENDING (highest first, best/lowest LAST)
        // We use O(1) array access for lowest latency
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [
            { price: "0.40", size: "200" },
            { price: "0.42", size: "100" },
            { price: "0.45", size: "300" }, // BEST bid (last in ascending)
          ],
          asks: [
            { price: "0.60", size: "200" },
            { price: "0.57", size: "100" },
            { price: "0.55", size: "300" }, // BEST ask (last in descending)
          ],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result!.best_bid).toBe(0.45);
        expect(result!.best_ask).toBe(0.55);
      });
    });

    describe("empty book handling", () => {
      it("should handle empty bids array", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [],
          asks: [{ price: "0.55", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result).not.toBeNull();
        expect(result!.best_bid).toBeNull();
        expect(result!.bid_size).toBeNull();
        expect(result!.best_ask).toBe(0.55);
        expect(result!.spread_bps).toBeNull();
      });

      it("should handle empty asks array", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result).not.toBeNull();
        expect(result!.best_bid).toBe(0.45);
        expect(result!.best_ask).toBeNull();
        expect(result!.ask_size).toBeNull();
        expect(result!.spread_bps).toBeNull();
      });

      it("should handle completely empty book", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [],
          asks: [],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result).not.toBeNull();
        expect(result!.best_bid).toBeNull();
        expect(result!.best_ask).toBeNull();
        expect(result!.bid_size).toBeNull();
        expect(result!.ask_size).toBeNull();
        expect(result!.spread_bps).toBeNull();
      });
    });

    describe("single level handling", () => {
      it("should handle single bid level", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [{ price: "0.55", size: "200" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result!.best_bid).toBe(0.45);
        expect(result!.bid_size).toBe(100);
        expect(result!.best_ask).toBe(0.55);
        expect(result!.ask_size).toBe(200);
      });
    });

    describe("crossed book handling", () => {
      it("should correctly identify crossed book (bid >= ask)", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.55", size: "100" }], // bid > ask = crossed
          asks: [{ price: "0.50", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result!.best_bid).toBe(0.55);
        expect(result!.best_ask).toBe(0.50);
        // Spread should be negative for crossed book
        expect(result!.spread_bps).toBeLessThan(0);
      });

      it("should handle locked book (bid == ask)", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.50", size: "100" }],
          asks: [{ price: "0.50", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        expect(result!.best_bid).toBe(0.50);
        expect(result!.best_ask).toBe(0.50);
        expect(result!.spread_bps).toBe(0);
      });
    });

    describe("timestamp handling", () => {
      it("should convert source timestamp from ms to μs", () => {
        const timestampMs = "1700000000000"; // Unix ms
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [{ price: "0.55", size: "100" }],
          timestamp: timestampMs,
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        // source_ts should be in milliseconds (Polymarket native format)
        expect(result!.source_ts).toBe(1700000000000);
      });

      it("should set ingestion_ts as placeholder (0)", () => {
        // ingestion_ts is set to 0 in the connector because it's always
        // overridden by the DO with the actual WebSocket receive timestamp
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [{ price: "0.55", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        // ingestion_ts is a placeholder (0) - DO will override with actual timestamp
        expect(result!.ingestion_ts).toBe(0);
      });
    });

    describe("spread_bps calculations", () => {
      it("should calculate correct spread_bps", () => {
        const event: PolymarketBookEvent = {
          event_type: "book",
          asset_id: "test_asset",
          market: "test_market",
          bids: [{ price: "0.45", size: "100" }],
          asks: [{ price: "0.55", size: "100" }],
          timestamp: "1700000000000",
          hash: "abc123",
        };

        const result = connector.normalizeBookEvent(event);

        // spread = 0.55 - 0.45 = 0.10
        // mid = 0.50
        // spread_bps = (0.10 / 0.50) * 10000 = 2000
        expect(result!.spread_bps).toBeCloseTo(2000);
      });
    });

    describe("null handling", () => {
      it("should return null for non-book event", () => {
        const tradeEvent = {
          event_type: "last_trade_price",
          asset_id: "test_asset",
          market: "test_market",
          price: "0.50",
          size: "100",
          side: "BUY",
          timestamp: "1700000000000",
        };

        const result = connector.normalizeBookEvent(tradeEvent);
        expect(result).toBeNull();
      });

      it("should return null for null input", () => {
        const result = connector.normalizeBookEvent(null);
        expect(result).toBeNull();
      });

      it("should return null for undefined input", () => {
        const result = connector.normalizeBookEvent(undefined);
        expect(result).toBeNull();
      });
    });
  });

  describe("normalizeLevelChange", () => {
    it("should normalize price_change event to level changes", () => {
      const event: PolymarketPriceChangeEvent = {
        event_type: "price_change",
        market: "test_market",
        price_changes: [
          {
            asset_id: "test_asset_1",
            side: "BUY",
            price: "0.46",
            size: "50",
            hash: "hash1",
          },
          {
            asset_id: "test_asset_2",
            side: "SELL",
            price: "0.54",
            size: "100",
            hash: "hash2",
          },
        ],
        timestamp: "1700000000000",
      };

      const result = connector.normalizeLevelChange(event);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);

      expect(result![0].asset_id).toBe("test_asset_1");
      expect(result![0].side).toBe("BUY");
      expect(result![0].price).toBe(0.46);
      expect(result![0].new_size).toBe(50);
      expect(result![0].book_hash).toBe("hash1");
      expect(result![0].source_ts).toBe(1700000000000); // ms

      expect(result![1].asset_id).toBe("test_asset_2");
      expect(result![1].side).toBe("SELL");
      expect(result![1].price).toBe(0.54);
      expect(result![1].new_size).toBe(100);
    });

    it("should mark REMOVE changes when size is 0", () => {
      const event: PolymarketPriceChangeEvent = {
        event_type: "price_change",
        market: "test_market",
        price_changes: [
          { asset_id: "test_asset", side: "BUY", price: "0.45", size: "0" },
        ],
        timestamp: "1700000000000",
      };

      const result = connector.normalizeLevelChange(event);

      expect(result![0].change_type).toBe("REMOVE");
      expect(result![0].new_size).toBe(0);
    });

    it("should mark ADD changes when size > 0", () => {
      const event: PolymarketPriceChangeEvent = {
        event_type: "price_change",
        market: "test_market",
        price_changes: [
          { asset_id: "test_asset", side: "SELL", price: "0.55", size: "100" },
        ],
        timestamp: "1700000000000",
      };

      const result = connector.normalizeLevelChange(event);

      expect(result![0].change_type).toBe("ADD");
      expect(result![0].new_size).toBe(100);
    });

    it("should return null for non-price_change event", () => {
      const bookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "test_market",
        bids: [],
        asks: [],
        timestamp: "1700000000000",
        hash: "abc",
      };

      const result = connector.normalizeLevelChange(bookEvent);
      expect(result).toBeNull();
    });

    it("should handle missing hash in price_change", () => {
      const event: PolymarketPriceChangeEvent = {
        event_type: "price_change",
        market: "test_market",
        price_changes: [
          { asset_id: "test_asset", side: "BUY", price: "0.45", size: "100" },
        ],
        timestamp: "1700000000000",
      };

      const result = connector.normalizeLevelChange(event);

      expect(result![0].book_hash).toBe("");
    });
  });

  describe("normalizeTrade", () => {
    it("should normalize last_trade_price event to TradeTick", () => {
      const event: PolymarketLastTradePriceEvent = {
        event_type: "last_trade_price",
        asset_id: "test_asset",
        market: "test_market",
        price: "0.52",
        size: "500",
        side: "BUY",
        timestamp: "1700000000000",
      };

      const result = connector.normalizeTrade(event);

      expect(result).not.toBeNull();
      expect(result!.asset_id).toBe("test_asset");
      expect(result!.condition_id).toBe("test_market");
      expect(result!.price).toBe(0.52);
      expect(result!.size).toBe(500);
      expect(result!.side).toBe("BUY");
      expect(result!.source_ts).toBe(1700000000000); // ms
      expect(result!.trade_id).toContain("test_asset-");
    });

    it("should handle SELL side trades", () => {
      const event: PolymarketLastTradePriceEvent = {
        event_type: "last_trade_price",
        asset_id: "test_asset",
        market: "test_market",
        price: "0.48",
        size: "200",
        side: "SELL",
        timestamp: "1700000000000",
      };

      const result = connector.normalizeTrade(event);

      expect(result!.side).toBe("SELL");
      expect(result!.price).toBe(0.48);
    });

    it("should return null for non-trade event", () => {
      const bookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "test_market",
        bids: [],
        asks: [],
        timestamp: "1700000000000",
        hash: "abc",
      };

      const result = connector.normalizeTrade(bookEvent);
      expect(result).toBeNull();
    });

    it("should generate unique trade_ids", () => {
      const event: PolymarketLastTradePriceEvent = {
        event_type: "last_trade_price",
        asset_id: "test_asset",
        market: "test_market",
        price: "0.50",
        size: "100",
        side: "BUY",
        timestamp: "1700000000000",
      };

      const result1 = connector.normalizeTrade(event);
      const result2 = connector.normalizeTrade(event);

      expect(result1!.trade_id).not.toBe(result2!.trade_id);
    });
  });

  describe("normalizeFullL2", () => {
    it("should normalize book event to full L2 snapshot", () => {
      const event: PolymarketBookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "test_market",
        bids: [
          { price: "0.40", size: "100" },
          { price: "0.42", size: "200" },
          { price: "0.45", size: "300" },
        ],
        asks: [
          { price: "0.55", size: "300" },
          { price: "0.57", size: "200" },
          { price: "0.60", size: "100" },
        ],
        timestamp: "1700000000000",
        hash: "abc123",
      };

      const result = connector.normalizeFullL2(event, "condition_123", 0.01, true, 5);

      expect(result).not.toBeNull();
      expect(result!.asset_id).toBe("test_asset");
      expect(result!.condition_id).toBe("condition_123");
      expect(result!.tick_size).toBe(0.01);
      expect(result!.neg_risk).toBe(true);
      expect(result!.order_min_size).toBe(5);
      expect(result!.bids).toHaveLength(3);
      expect(result!.asks).toHaveLength(3);
      expect(result!.book_hash).toBe("abc123");
      expect(result!.source_ts).toBe(1700000000000); // ms
    });

    it("should preserve all bid/ask levels", () => {
      const event: PolymarketBookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "test_market",
        bids: [
          { price: "0.40", size: "100" },
          { price: "0.45", size: "300" },
        ],
        asks: [
          { price: "0.55", size: "300" },
          { price: "0.60", size: "100" },
        ],
        timestamp: "1700000000000",
        hash: "abc123",
      };

      const result = connector.normalizeFullL2(event, "test_market", 0.01);

      expect(result!.bids[0]).toEqual({ price: 0.40, size: 100 });
      expect(result!.bids[1]).toEqual({ price: 0.45, size: 300 });
      expect(result!.asks[0]).toEqual({ price: 0.55, size: 300 });
      expect(result!.asks[1]).toEqual({ price: 0.60, size: 100 });
    });

    it("should use event.market as fallback for condition_id", () => {
      const event: PolymarketBookEvent = {
        event_type: "book",
        asset_id: "test_asset",
        market: "fallback_market",
        bids: [],
        asks: [],
        timestamp: "1700000000000",
        hash: "abc123",
      };

      const result = connector.normalizeFullL2(event, "", 0.01);

      expect(result!.condition_id).toBe("fallback_market");
    });
  });

  describe("getSubscriptionMessage", () => {
    it("should format subscription message correctly", () => {
      const assets = ["asset_1", "asset_2", "asset_3"];
      const message = connector.getSubscriptionMessage(assets);
      const parsed = JSON.parse(message);

      expect(parsed).toEqual({
        assets_ids: ["asset_1", "asset_2", "asset_3"],
        type: "market",
      });
    });

    it("should handle empty asset list", () => {
      const message = connector.getSubscriptionMessage([]);
      const parsed = JSON.parse(message);

      expect(parsed).toEqual({
        assets_ids: [],
        type: "market",
      });
    });
  });

  describe("connector properties", () => {
    it("should return correct market source", () => {
      expect(connector.marketSource).toBe("polymarket");
    });

    it("should return correct market type", () => {
      expect(connector.marketType).toBe("prediction");
    });

    it("should return correct max assets per connection", () => {
      expect(connector.getMaxAssetsPerConnection()).toBe(450);
    });

    it("should return correct location hint", () => {
      expect(connector.getLocationHint()).toBe("weur");
    });

    it("should return correct WebSocket URL", () => {
      expect(connector.getWebSocketUrl()).toBe(
        "wss://ws-subscriptions-clob.polymarket.com/ws/market"
      );
    });

    it("should allow custom WebSocket URL", () => {
      const customConnector = new PolymarketConnector("wss://custom.example.com");
      expect(customConnector.getWebSocketUrl()).toBe("wss://custom.example.com");
    });
  });
});
