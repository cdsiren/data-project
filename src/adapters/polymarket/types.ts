// src/adapters/polymarket/types.ts
// Polymarket-specific types for WebSocket events and API responses

/**
 * Polymarket WebSocket book event (full orderbook snapshot)
 * Received from wss://ws-subscriptions-clob.polymarket.com
 */
export interface PolymarketBookEvent {
  event_type: "book";
  asset_id: string;
  market: string; // condition_id
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string; // Unix ms as string
  hash: string; // Critical for gap detection
}

/**
 * Polymarket price_change event - incremental orderbook updates
 * Note: asset_id is inside each price_change, not at top level
 */
export interface PolymarketPriceChangeEvent {
  event_type: "price_change";
  market: string; // condition_id at top level
  price_changes: Array<{
    asset_id: string; // Asset ID is per-change, not per-event
    side: "BUY" | "SELL";
    price: string;
    size: string;
    hash?: string;
    best_bid?: string;
    best_ask?: string;
  }>;
  timestamp: string;
}

/**
 * Polymarket last_trade_price event - trade execution
 */
export interface PolymarketLastTradePriceEvent {
  event_type: "last_trade_price";
  asset_id: string;
  market: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  timestamp: string;
}

/**
 * Polymarket tick_size_change event
 */
export interface PolymarketTickSizeChangeEvent {
  event_type: "tick_size_change";
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
}

/**
 * Union type for all Polymarket WebSocket events
 */
export type PolymarketWSEvent =
  | PolymarketBookEvent
  | PolymarketPriceChangeEvent
  | PolymarketLastTradePriceEvent
  | PolymarketTickSizeChangeEvent;

/**
 * Polymarket Event from Gamma API
 */
export interface PolymarketEvent {
  id: string;
  title: string;
  ticker?: string;
  slug?: string;
  description?: string;
  resolutionSource?: string;
  startDate?: string;
  creationDate?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
}

/**
 * Polymarket Market from Gamma API
 */
export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  startDate: string;
  createdAt: string;
  submitted_by: string;
  resolvedBy: string;
  restricted: boolean;
  enableOrderBook: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  clobTokenIds: string; // JSON array of token IDs
  negRisk: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  events: PolymarketEvent[];
}

/**
 * Goldsky trade event from blockchain indexer
 */
export interface GoldskyTradeEvent {
  id: string;
  transaction_hash: string | null;
  timestamp: string;
  order_hash: string | null;
  maker: string;
  taker: string;
  maker_asset_id: string;
  taker_asset_id: string;
  maker_amount_filled: string;
  taker_amount_filled: string;
  fee: string;
  chain_id: number;
  _gs_chain: string;
  _gs_gid: string;
  is_deleted: number;
}

/**
 * Polymarket-specific cache value for KV
 */
export interface PolymarketCacheValue {
  condition_id: string;
  order_price_min_tick_size: number;
  neg_risk: boolean;
  order_min_size: number;
  end_date: string;
}

/**
 * Gamma API market response (for fetching recently closed/created markets)
 */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  closed: boolean;
  archived: boolean;
  active: boolean;
  enableOrderBook: boolean;
  clobTokenIds: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  resolvedBy?: string;
  resolutionSource?: string;
}
