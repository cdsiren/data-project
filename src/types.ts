import type {
  GapBackfillJob,
  TradeTick,
  BBOSnapshot,
  OrderbookLevelChange,
  FullL2Snapshot,
} from "./types/orderbook";
import type { MarketSource, MarketType } from "./core/enums";

export interface Env {
  // KV Namespaces
  MARKET_CACHE: KVNamespace;
  HASH_CHAIN_CACHE: KVNamespace;

  // Queues
  SNAPSHOT_QUEUE: Queue<BBOSnapshot>;
  GAP_BACKFILL_QUEUE: Queue<GapBackfillJob>;
  TRADE_QUEUE: Queue<TradeTick>;
  LEVEL_CHANGE_QUEUE: Queue<OrderbookLevelChange>;
  FULL_L2_QUEUE: Queue<FullL2Snapshot>;
  DEAD_LETTER_QUEUE: Queue<DeadLetterMessage>;

  // Durable Objects
  ORDERBOOK_MANAGER: DurableObjectNamespace;

  // Environment Variables
  GAMMA_API_URL: string;
  CLOB_WSS_URL: string;
  SNAPSHOT_INTERVAL_MS: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_TOKEN: string;
  WEBHOOK_API_KEY: string;
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

// Dead Letter Queue message for failed processing
export interface DeadLetterMessage {
  market_source?: MarketSource;
  market_type?: MarketType;
  original_queue: string;
  message_type: "bbo_snapshot" | "gap_backfill" | "trade_tick" | "level_change" | "full_l2";
  payload: unknown;
  error: string;
  failed_at: string;
  retry_count: number;
}
