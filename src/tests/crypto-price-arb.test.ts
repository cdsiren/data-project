/**
 * CRYPTO_PRICE_ARB Trigger Tests
 *
 * Tests:
 * 1. CryptoMarketParser - parsing market questions into structured metadata
 * 2. Implied probability calculation - logistic approximation of normal CDF
 * 3. Fee estimation - Polymarket fee model
 * 4. RTDS connector - subscription/parse format
 * 5. Trigger evaluation - full end-to-end evaluation logic
 *
 * Run with: npx vitest run src/tests/crypto-price-arb.test.ts
 */

import { describe, it, expect } from "vitest";
import { parseCryptoMarket, type CryptoPriceMarketInfo } from "../services/crypto-market-parser";
import {
  calculateImpliedProbability,
  estimatePolymarketFees,
  STALE_DATA_THRESHOLD_MS,
} from "../utils/arbitrage-calculations";
import { RTDSConnector, RTDS_SUPPORTED_SYMBOLS } from "../adapters/data-feeds/rtds-connector";

// ============================================================
// CryptoMarketParser Tests
// ============================================================
describe("CryptoMarketParser", () => {
  const futureDate = new Date("2026-03-01T14:00:00Z").toISOString();

  it("parses BTC above question", () => {
    const result = parseCryptoMarket(
      "Will BTC be above $100,000 at 2:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("btcusdt");
    expect(result!.strikePrice).toBe(100000);
    expect(result!.direction).toBe("ABOVE");
  });

  it("parses ETH below question", () => {
    const result = parseCryptoMarket(
      "Will Ethereum be below $3,500.50 at 3:30 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("ethusdt");
    expect(result!.strikePrice).toBe(3500.50);
    expect(result!.direction).toBe("BELOW");
  });

  it("parses SOL above question with 'go' phrasing", () => {
    const result = parseCryptoMarket(
      "Will SOL go above $200 by 2:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("solusdt");
    expect(result!.strikePrice).toBe(200);
    expect(result!.direction).toBe("ABOVE");
  });

  it("parses XRP question with 'price of' phrasing", () => {
    const result = parseCryptoMarket(
      "Will the price of XRP be above $1.50 at 12:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("xrpusdt");
    expect(result!.strikePrice).toBe(1.5);
    expect(result!.direction).toBe("ABOVE");
  });

  it("parses Bitcoin (full name) question", () => {
    const result = parseCryptoMarket(
      "Will Bitcoin be above $95,500 at 2:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("btcusdt");
    expect(result!.strikePrice).toBe(95500);
  });

  it("parses DOGE question", () => {
    const result = parseCryptoMarket(
      "Will DOGE be above $0.15 at 2:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("dogeusdt");
    expect(result!.strikePrice).toBe(0.15);
  });

  it("returns null for non-crypto market", () => {
    const result = parseCryptoMarket(
      "Will Trump win the 2028 election?",
      futureDate
    );
    expect(result).toBeNull();
  });

  it("returns null for unsupported crypto", () => {
    const result = parseCryptoMarket(
      "Will ADA be above $1.00 at 2:00 PM ET?",
      futureDate
    );
    expect(result).toBeNull();
  });

  it("handles numeric endDate", () => {
    const ts = new Date("2026-03-01T14:00:00Z").getTime();
    const result = parseCryptoMarket(
      "Will BTC be above $100,000 at 2:00 PM ET?",
      ts
    );
    expect(result).not.toBeNull();
    expect(result!.resolutionTime).toBe(ts);
  });

  it("handles decimal strike prices", () => {
    const result = parseCryptoMarket(
      "Will ETH be above $3,456.78 at 2:00 PM ET?",
      futureDate
    );
    expect(result).not.toBeNull();
    expect(result!.strikePrice).toBe(3456.78);
  });
});

// ============================================================
// Implied Probability Tests
// ============================================================
describe("calculateImpliedProbability", () => {
  it("returns ~1.0 when price is far above strike (ABOVE market)", () => {
    // BTC at 110000, strike at 100000, 10 min to resolution
    const prob = calculateImpliedProbability(110000, 100000, "ABOVE", 10 * 60000);
    expect(prob).toBeGreaterThan(0.95);
  });

  it("returns ~0.0 when price is far below strike (ABOVE market)", () => {
    // BTC at 90000, strike at 100000, 10 min to resolution
    const prob = calculateImpliedProbability(90000, 100000, "ABOVE", 10 * 60000);
    expect(prob).toBeLessThan(0.05);
  });

  it("returns ~0.5 when price is at strike", () => {
    const prob = calculateImpliedProbability(100000, 100000, "ABOVE", 10 * 60000);
    expect(prob).toBeGreaterThan(0.45);
    expect(prob).toBeLessThan(0.55);
  });

  it("inverts for BELOW direction", () => {
    const probAbove = calculateImpliedProbability(105000, 100000, "ABOVE", 10 * 60000);
    const probBelow = calculateImpliedProbability(105000, 100000, "BELOW", 10 * 60000);
    // They should roughly sum to 1
    expect(probAbove + probBelow).toBeCloseTo(1.0, 1);
  });

  it("time decay: less time = more extreme probabilities", () => {
    // Price slightly above strike - shorter time should mean higher probability of staying above
    // Use a small offset so neither value hits the 0.99 clamp
    const prob10min = calculateImpliedProbability(100200, 100000, "ABOVE", 10 * 60000);
    const prob2min = calculateImpliedProbability(100200, 100000, "ABOVE", 2 * 60000);
    expect(prob2min).toBeGreaterThan(prob10min);
  });

  it("clamps to [0.01, 0.99] range", () => {
    // Very far from strike should still be within bounds
    const prob = calculateImpliedProbability(200000, 100000, "ABOVE", 1 * 60000);
    expect(prob).toBeLessThanOrEqual(0.99);
    expect(prob).toBeGreaterThanOrEqual(0.01);
  });

  it("returns 0.5 for invalid inputs", () => {
    expect(calculateImpliedProbability(0, 100000, "ABOVE", 10 * 60000)).toBe(0.5);
    expect(calculateImpliedProbability(100000, 0, "ABOVE", 10 * 60000)).toBe(0.5);
    expect(calculateImpliedProbability(100000, 100000, "ABOVE", 0)).toBe(0.5);
  });

  it("custom volatility affects probability", () => {
    // Higher vol = more uncertainty = closer to 0.5
    const lowVol = calculateImpliedProbability(102000, 100000, "ABOVE", 10 * 60000, 0.0005);
    const highVol = calculateImpliedProbability(102000, 100000, "ABOVE", 10 * 60000, 0.005);
    // Low vol should be more confident (further from 0.5)
    expect(Math.abs(lowVol - 0.5)).toBeGreaterThan(Math.abs(highVol - 0.5));
  });
});

// ============================================================
// Fee Estimation Tests
// ============================================================
describe("estimatePolymarketFees", () => {
  it("returns base fee for normal duration", () => {
    const fees = estimatePolymarketFees(10 * 60 * 1000); // 10 minutes
    expect(fees).toBe(200);
  });

  it("returns higher fee for short duration", () => {
    const fees = estimatePolymarketFees(3 * 60 * 1000); // 3 minutes
    expect(fees).toBe(250); // base + urgency premium
  });

  it("returns higher fee for very short duration", () => {
    const fees = estimatePolymarketFees(60 * 1000); // 1 minute
    expect(fees).toBe(250);
  });
});

// ============================================================
// RTDS Connector Tests
// ============================================================
describe("RTDSConnector", () => {
  const connector = new RTDSConnector("wss://ws-live-data.polymarket.com");

  it("returns correct WebSocket URL", () => {
    expect(connector.getWebSocketUrl()).toBe("wss://ws-live-data.polymarket.com");
  });

  it("generates correct subscription message per RTDS docs", () => {
    const msg = JSON.parse(connector.getSubscriptionMessage());
    expect(msg.action).toBe("subscribe");
    expect(msg.subscriptions).toHaveLength(1);
    expect(msg.subscriptions[0].topic).toBe("crypto_prices");
    expect(msg.subscriptions[0].type).toBe("update");
    expect(msg.subscriptions[0].filters).toContain("btcusdt");
    expect(msg.subscriptions[0].filters).toContain("ethusdt");
    expect(msg.subscriptions[0].filters).toContain("solusdt");
  });

  it("parses valid crypto price message with lowercase symbols", () => {
    const msg = connector.parseMessage(JSON.stringify({
      topic: "crypto_prices",
      type: "update",
      timestamp: 1709251200237,
      payload: {
        symbol: "btcusdt",
        value: 100500.25,
        timestamp: 1709251200000,
      },
    }));
    expect(msg).not.toBeNull();
    expect(msg!.symbol).toBe("btcusdt");
    expect(msg!.value).toBe(100500.25);
    expect(msg!.timestamp).toBe(1709251200000);
    expect(msg!.source).toBe("binance");
  });

  it("normalizes uppercase symbols to lowercase", () => {
    const msg = connector.parseMessage(JSON.stringify({
      topic: "crypto_prices",
      payload: {
        symbol: "ETHUSDT",
        value: 3500,
        timestamp: 1709251200000,
      },
    }));
    expect(msg).not.toBeNull();
    expect(msg!.symbol).toBe("ethusdt");
  });

  it("returns null for non-crypto topic", () => {
    const msg = connector.parseMessage(JSON.stringify({
      topic: "other_topic",
      payload: { symbol: "btcusdt", value: 100000, timestamp: 123 },
    }));
    expect(msg).toBeNull();
  });

  it("returns null for messages without payload keyword", () => {
    expect(connector.parseMessage("pong")).toBeNull();
    expect(connector.parseMessage("not json")).toBeNull();
  });

  it("returns null for missing payload field", () => {
    const msg = connector.parseMessage(JSON.stringify({
      topic: "crypto_prices",
      payload: null,
    }));
    expect(msg).toBeNull();
  });

  it("exports supported symbols in lowercase", () => {
    expect(RTDS_SUPPORTED_SYMBOLS).toContain("btcusdt");
    expect(RTDS_SUPPORTED_SYMBOLS).toContain("ethusdt");
    expect(RTDS_SUPPORTED_SYMBOLS).toContain("solusdt");
    expect(RTDS_SUPPORTED_SYMBOLS).toContain("xrpusdt");
    expect(RTDS_SUPPORTED_SYMBOLS).toContain("dogeusdt");
  });
});

// ============================================================
// Trigger Evaluation Tests (simulates checkTriggerCondition)
// ============================================================
describe("CRYPTO_PRICE_ARB trigger evaluation", () => {
  interface ExternalPrice {
    value: number;
    timestamp: number;
    receivedAt: number;
  }

  interface EvalParams {
    cryptoSymbol: string;
    strikePrice: number;
    marketDirection: "ABOVE" | "BELOW";
    threshold: number;
    minTimeToResolutionMs: number;
    externalPrice: ExternalPrice;
    resolutionTime: number;
    bestBid: number;
    bestAsk: number;
    askSize: number;
    bidSize?: number;
    counterpartBestAsk?: number | null;
  }

  /**
   * Simulates the CRYPTO_PRICE_ARB evaluation from checkTriggerCondition
   */
  function evaluateCryptoPriceArb(params: EvalParams): {
    fired: boolean;
    netDivergenceBps?: number;
    impliedProbability?: number;
    tradeDirection?: "BUY_YES" | "SELL_YES";
    hasStructuralArb?: boolean;
  } {
    const nowMs = Date.now();

    // Check external price staleness
    if (nowMs - params.externalPrice.receivedAt > STALE_DATA_THRESHOLD_MS) {
      return { fired: false };
    }

    // Time-to-resolution guard
    const timeToResolutionMs = params.resolutionTime - nowMs;
    if (timeToResolutionMs < params.minTimeToResolutionMs) {
      return { fired: false };
    }

    // Calculate implied probability
    const impliedProb = calculateImpliedProbability(
      params.externalPrice.value,
      params.strikePrice,
      params.marketDirection,
      timeToResolutionMs
    );

    // Market probability from mid-price (fair value)
    if (params.bestBid <= 0 || params.bestAsk <= 0) return { fired: false };
    const marketProb = (params.bestBid + params.bestAsk) / 2;

    // Divergence (preserve sign for trade direction)
    const rawDivergence = impliedProb - marketProb;
    const divergenceBps = Math.abs(rawDivergence) * 10000;
    const feeEstimateBps = estimatePolymarketFees(timeToResolutionMs);
    const netDivergenceBps = divergenceBps - feeEstimateBps;

    // Trade direction
    const tradeDirection = rawDivergence > 0 ? "BUY_YES" as const : "SELL_YES" as const;

    // Check structural arb
    let hasStructuralArb = false;
    if (params.counterpartBestAsk != null) {
      const sumOfAsks = params.bestAsk + params.counterpartBestAsk;
      if (sumOfAsks < 1.0) {
        hasStructuralArb = true;
      }
    }

    if (netDivergenceBps >= params.threshold) {
      return {
        fired: true,
        netDivergenceBps,
        impliedProbability: impliedProb,
        tradeDirection,
        hasStructuralArb,
      };
    }

    return { fired: false, netDivergenceBps, impliedProbability: impliedProb, tradeDirection };
  }

  const nowMs = Date.now();
  const futureResolution = nowMs + 10 * 60 * 1000; // 10 minutes from now

  it("fires when net divergence exceeds threshold", () => {
    // BTC far above strike -> implied ~0.99, but market says 0.50 -> huge divergence
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500, // 5% = 500 bps
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 110000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.48,
      bestAsk: 0.52, // mid = 0.50, Market way off
      askSize: 1000,
    });

    expect(result.fired).toBe(true);
    expect(result.netDivergenceBps).toBeGreaterThan(500);
    expect(result.tradeDirection).toBe("BUY_YES"); // implied > market
  });

  it("does not fire when divergence is below threshold", () => {
    // BTC right at strike -> implied ~0.50, market also ~0.50
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 100000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.48,
      bestAsk: 0.52, // mid = 0.50
      askSize: 1000,
    });

    expect(result.fired).toBe(false);
  });

  it("does not fire when external price is stale", () => {
    const staleReceivedAt = nowMs - STALE_DATA_THRESHOLD_MS - 1000;
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 110000, timestamp: nowMs, receivedAt: staleReceivedAt },
      resolutionTime: futureResolution,
      bestBid: 0.48,
      bestAsk: 0.52,
      askSize: 1000,
    });

    expect(result.fired).toBe(false);
  });

  it("does not fire when too close to resolution", () => {
    const nearResolution = nowMs + 60000; // Only 1 minute left
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500,
      minTimeToResolutionMs: 120000, // 2 min guard
      externalPrice: { value: 110000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: nearResolution,
      bestBid: 0.48,
      bestAsk: 0.52,
      askSize: 1000,
    });

    expect(result.fired).toBe(false);
  });

  it("subtracts fees from divergence", () => {
    // Create a case where gross divergence is moderate but net (after 200bps fees) < threshold
    // Price at strike means implied ~0.50, mid-price at 0.47 gives ~300 bps gross divergence
    // After 200 bps fees: net = 100 bps < 500 threshold
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 100000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.45,
      bestAsk: 0.49, // mid = 0.47, ~300 bps from implied ~0.50
      askSize: 1000,
    });

    // The net divergence should be less than threshold (300 - 200 = 100 < 500)
    expect(result.fired).toBe(false);
    if (result.netDivergenceBps !== undefined) {
      expect(result.netDivergenceBps).toBeLessThan(500);
    }
  });

  it("detects structural arb as secondary signal", () => {
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "ABOVE",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 110000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.43,
      bestAsk: 0.47, // mid = 0.45
      askSize: 1000,
      counterpartBestAsk: 0.45, // YES_ask + NO_ask = 0.47 + 0.45 = 0.92 < 1.0
    });

    expect(result.fired).toBe(true);
    expect(result.hasStructuralArb).toBe(true);
  });

  it("handles BELOW market direction correctly", () => {
    // BTC far below strike -> high probability of being below
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "BELOW",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 90000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.48,
      bestAsk: 0.52, // mid = 0.50, Market hasn't adjusted
      askSize: 1000,
    });

    expect(result.fired).toBe(true);
    expect(result.impliedProbability).toBeGreaterThan(0.9);
    expect(result.tradeDirection).toBe("BUY_YES"); // implied > market
  });

  it("recommends SELL_YES when implied probability is below market", () => {
    // BTC far above strike on a BELOW market -> implied probability near 0
    // But market still says ~0.50 -> should SELL YES
    const result = evaluateCryptoPriceArb({
      cryptoSymbol: "btcusdt",
      strikePrice: 100000,
      marketDirection: "BELOW",
      threshold: 500,
      minTimeToResolutionMs: 120000,
      externalPrice: { value: 110000, timestamp: nowMs, receivedAt: nowMs },
      resolutionTime: futureResolution,
      bestBid: 0.48,
      bestAsk: 0.52, // mid = 0.50, Market hasn't adjusted
      askSize: 1000,
      bidSize: 800,
    });

    expect(result.fired).toBe(true);
    expect(result.impliedProbability).toBeLessThan(0.1);
    expect(result.tradeDirection).toBe("SELL_YES"); // implied < market
  });
});
