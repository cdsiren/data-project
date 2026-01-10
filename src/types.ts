import type { GapBackfillJob, TradeTick } from "./types/orderbook";

export interface Env {
  MARKET_CACHE: KVNamespace;
  METADATA_QUEUE: Queue;
  SNAPSHOT_QUEUE: Queue;
  ORDERBOOK_MANAGER: DurableObjectNamespace;
  GAMMA_API_URL: string;
  CLOB_WSS_URL: string;
  SNAPSHOT_INTERVAL_MS: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_TOKEN: string;
  WEBHOOK_API_KEY: string;
  // New bindings for orderbook gap detection
  HASH_CHAIN_CACHE: KVNamespace;
  GAP_BACKFILL_QUEUE: Queue<GapBackfillJob>;
  // Trade tick queue for execution-level data (backtesting)
  TRADE_QUEUE: Queue<TradeTick>;
}

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

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface OrderbookSnapshot {
  condition_id: string;
  token_id: string;
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  best_bid: string | null;
  best_ask: string | null;
  spread: number | null;
}

export interface MetadataFetchJob {
  clob_token_id: string;
}

// Polymarket API Response Types
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
  clobTokenIds: string;
  negRisk: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  events: PolymarketEvent[];
}

// Database record types
export interface MarketMetadataRecord {
  id: string;
  question: string;
  condition_id: string;
  slug: string;
  resolution_source: string;
  end_date: string;
  start_date: string;
  created_at: string;
  submitted_by: string;
  resolved_by: string;
  restricted: number; // Boolean as 0/1 for ClickHouse
  enable_order_book: number;
  order_price_min_tick_size: number;
  order_min_size: number;
  clob_token_ids: string;
  neg_risk: number;
  neg_risk_market_id: string;
  neg_risk_request_id: string;
}

export interface MarketEventRecord {
  event_id: string;
  market_id: string; // Foreign key to MarketMetadataRecord.id
  title: string;
}
