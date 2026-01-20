// src/adapters/polymarket/normalizers.ts
// Functions to convert Polymarket-specific types to canonical types

import type { MarketSource } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";
import { buildInstrumentID } from "../../core/instrument";
import type { BBOSnapshot, TradeTick, OrderbookLevelChange, FullL2Snapshot, LocalOrderbook } from "../../core/orderbook";
import type { MarketMetadata } from "../../core/market-data";
import type {
  PolymarketBookEvent,
  PolymarketPriceChangeEvent,
  PolymarketLastTradePriceEvent,
  PolymarketMarket,
} from "./types";

const MARKET_SOURCE: MarketSource = "polymarket";

/**
 * Build a canonical instrument ID for a Polymarket asset
 */
export function buildPolymarketInstrumentID(assetId: string): InstrumentID {
  return buildInstrumentID(MARKET_SOURCE, "BINARY_OPTION", assetId);
}

/**
 * Normalize Polymarket book event to canonical BBO snapshot
 */
export function normalizeBookEventToBBO(
  event: PolymarketBookEvent,
  conditionId: string,
  ingestionTs: number,
  tickSize: number,
  sequenceNumber: number,
  negRisk?: boolean,
  orderMinSize?: number
): BBOSnapshot {
  const sourceTs = parseInt(event.timestamp);
  const bids = event.bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));
  const asks = event.asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));

  // CRITICAL FIX: Polymarket returns bids ASCENDING (lowest first) and asks DESCENDING (highest first)
  // Best bid = HIGHEST bid price (max), Best ask = LOWEST ask price (min)
  const bestBidLevel = bids.length > 0
    ? bids.reduce((best, curr) => curr.price > best.price ? curr : best)
    : null;
  const bestAskLevel = asks.length > 0
    ? asks.reduce((best, curr) => curr.price < best.price ? curr : best)
    : null;

  const bestBid = bestBidLevel?.price ?? null;
  const bestAsk = bestAskLevel?.price ?? null;
  const bidSize = bestBidLevel?.size ?? null;
  const askSize = bestAskLevel?.size ?? null;

  const midPrice = bestBid !== null && bestAsk !== null
    ? (bestBid + bestAsk) / 2
    : null;

  const spreadBps = bestBid !== null && bestAsk !== null && midPrice !== null && midPrice > 0
    ? ((bestAsk - bestBid) / midPrice) * 10000
    : null;

  return {
    market_source: MARKET_SOURCE,
    asset_id: event.asset_id,
    token_id: event.asset_id,
    condition_id: conditionId,
    source_ts: sourceTs,
    ingestion_ts: ingestionTs,
    book_hash: event.hash,
    best_bid: bestBid,
    best_ask: bestAsk,
    bid_size: bidSize,
    ask_size: askSize,
    mid_price: midPrice,
    spread_bps: spreadBps,
    tick_size: tickSize,
    is_resync: false,
    sequence_number: sequenceNumber,
    neg_risk: negRisk,
    order_min_size: orderMinSize,
  };
}

/**
 * Normalize Polymarket book event to canonical Full L2 snapshot
 */
export function normalizeBookEventToFullL2(
  event: PolymarketBookEvent,
  conditionId: string,
  ingestionTs: number,
  tickSize: number,
  sequenceNumber: number,
  negRisk?: boolean,
  orderMinSize?: number
): FullL2Snapshot {
  const sourceTs = parseInt(event.timestamp);
  const bids = event.bids.map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));
  const asks = event.asks.map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));

  return {
    market_source: MARKET_SOURCE,
    asset_id: event.asset_id,
    token_id: event.asset_id,
    condition_id: conditionId,
    source_ts: sourceTs,
    ingestion_ts: ingestionTs,
    book_hash: event.hash,
    bids,
    asks,
    tick_size: tickSize,
    sequence_number: sequenceNumber,
    neg_risk: negRisk,
    order_min_size: orderMinSize,
  };
}

/**
 * Normalize Polymarket trade event to canonical TradeTick
 */
export function normalizeTradeEvent(
  event: PolymarketLastTradePriceEvent,
  conditionId: string,
  ingestionTs: number
): TradeTick {
  const sourceTs = parseInt(event.timestamp);
  return {
    market_source: MARKET_SOURCE,
    asset_id: event.asset_id,
    condition_id: conditionId,
    trade_id: `${event.asset_id}-${sourceTs}-${crypto.randomUUID().slice(0, 8)}`,
    price: parseFloat(event.price),
    size: parseFloat(event.size),
    side: event.side,
    source_ts: sourceTs,
    ingestion_ts: ingestionTs,
  };
}

/**
 * Normalize Polymarket price change to canonical level changes
 */
export function normalizePriceChanges(
  event: PolymarketPriceChangeEvent,
  assetId: string,
  conditionId: string,
  ingestionTs: number,
  localBook: LocalOrderbook
): OrderbookLevelChange[] {
  const sourceTs = parseInt(event.timestamp);
  const levelChanges: OrderbookLevelChange[] = [];

  // Get changes for this specific asset
  const assetChanges = event.price_changes.filter((c) => c.asset_id === assetId);

  for (const change of assetChanges) {
    const price = parseFloat(change.price);
    const newSize = parseFloat(change.size);
    const isBuy = change.side === "BUY";
    const book = isBuy ? localBook.bids : localBook.asks;
    const oldSize = book.get(price) ?? 0;

    // Determine change type
    let changeType: "ADD" | "REMOVE" | "UPDATE";
    if (oldSize === 0 && newSize > 0) {
      changeType = "ADD";
    } else if (newSize === 0 && oldSize > 0) {
      changeType = "REMOVE";
    } else {
      changeType = "UPDATE";
    }

    levelChanges.push({
      market_source: MARKET_SOURCE,
      asset_id: assetId,
      condition_id: conditionId,
      source_ts: sourceTs,
      ingestion_ts: ingestionTs,
      side: change.side,
      price,
      old_size: oldSize,
      new_size: newSize,
      size_delta: newSize - oldSize,
      change_type: changeType,
      book_hash: change.hash || localBook.last_hash,
      sequence_number: localBook.sequence + 1,
    });
  }

  return levelChanges;
}

/**
 * Normalize Polymarket market metadata to canonical format
 */
export function normalizeMarketMetadata(market: PolymarketMarket, tokenId: string): MarketMetadata {
  return {
    instrumentId: buildPolymarketInstrumentID(tokenId),
    instrumentType: "BINARY_OPTION",
    marketSource: MARKET_SOURCE,
    marketType: "prediction",
    nativeId: tokenId,
    marketId: market.conditionId,
    question: market.question,
    symbol: market.slug,
    tickSize: market.orderPriceMinTickSize,
    minOrderSize: market.orderMinSize,
    priceMin: 0,
    priceMax: 1,
    startDate: market.startDate,
    endDate: market.endDate,
    active: !market.restricted && market.enableOrderBook,
    resolved: !!market.resolvedBy,
    extensions: {
      neg_risk: market.negRisk,
      neg_risk_market_id: market.negRiskMarketID,
      neg_risk_request_id: market.negRiskRequestID,
      condition_id: market.conditionId,
      clob_token_ids: market.clobTokenIds,
      resolution_source: market.resolutionSource,
      resolved_by: market.resolvedBy,
      slug: market.slug,
      submitted_by: market.submitted_by,
    },
  };
}

/**
 * Create a BBO snapshot from local book state
 */
export function createBBOFromLocalBook(
  assetId: string,
  conditionId: string,
  sourceTs: number,
  ingestionTs: number,
  localBook: LocalOrderbook,
  bestBid: number | null,
  bestAsk: number | null,
  negRisk?: boolean,
  orderMinSize?: number
): BBOSnapshot {
  const bidSize = bestBid !== null ? localBook.bids.get(bestBid) ?? null : null;
  const askSize = bestAsk !== null ? localBook.asks.get(bestAsk) ?? null : null;

  const midPrice = bestBid !== null && bestAsk !== null
    ? (bestBid + bestAsk) / 2
    : null;

  const spreadBps = bestBid !== null && bestAsk !== null && midPrice !== null && midPrice > 0
    ? ((bestAsk - bestBid) / midPrice) * 10000
    : null;

  return {
    market_source: MARKET_SOURCE,
    asset_id: assetId,
    token_id: assetId,
    condition_id: conditionId,
    source_ts: sourceTs,
    ingestion_ts: ingestionTs,
    book_hash: localBook.last_hash,
    best_bid: bestBid,
    best_ask: bestAsk,
    bid_size: bidSize,
    ask_size: askSize,
    mid_price: midPrice,
    spread_bps: spreadBps,
    tick_size: localBook.tick_size,
    is_resync: false,
    sequence_number: localBook.sequence,
    neg_risk: negRisk,
    order_min_size: orderMinSize,
  };
}

/**
 * Create Full L2 snapshot from local book state
 */
export function createFullL2FromLocalBook(
  assetId: string,
  conditionId: string,
  sourceTs: number,
  ingestionTs: number,
  localBook: LocalOrderbook,
  negRisk?: boolean,
  orderMinSize?: number
): FullL2Snapshot {
  // Sort bids descending (highest first), asks ascending (lowest first)
  const sortedBids = Array.from(localBook.bids.entries())
    .sort(([a], [b]) => b - a)
    .map(([price, size]) => ({ price, size }));

  const sortedAsks = Array.from(localBook.asks.entries())
    .sort(([a], [b]) => a - b)
    .map(([price, size]) => ({ price, size }));

  return {
    market_source: MARKET_SOURCE,
    asset_id: assetId,
    token_id: assetId,
    condition_id: conditionId,
    source_ts: sourceTs,
    ingestion_ts: ingestionTs,
    book_hash: localBook.last_hash,
    bids: sortedBids,
    asks: sortedAsks,
    tick_size: localBook.tick_size,
    sequence_number: localBook.sequence,
    neg_risk: negRisk,
    order_min_size: orderMinSize,
  };
}
