import type {
  GapBackfillJob,
  TradeTick,
  BBOSnapshot,
  OrderbookLevelChange,
  FullL2Snapshot,
} from "./types/orderbook";
import type { MarketSource, MarketType } from "./core/enums";
import type { GraphQueueMessage } from "./services/graph/types";

// Re-export Polymarket types from their canonical location (avoid duplication)
export type {
  PolymarketEvent,
  PolymarketMarket,
} from "./adapters/polymarket/types";

export interface Env {
  // KV Namespaces
  MARKET_CACHE: KVNamespace;
  HASH_CHAIN_CACHE: KVNamespace;
  GRAPH_CACHE: KVNamespace;           // Graph adjacency list cache
  CROSS_SHARD_KV: KVNamespace;        // Cross-shard coordination for compound triggers

  // Queues
  SNAPSHOT_QUEUE: Queue<BBOSnapshot>;
  GAP_BACKFILL_QUEUE: Queue<GapBackfillJob>;
  TRADE_QUEUE: Queue<TradeTick>;
  LEVEL_CHANGE_QUEUE: Queue<OrderbookLevelChange>;
  FULL_L2_QUEUE: Queue<FullL2Snapshot>;
  DEAD_LETTER_QUEUE: Queue<DeadLetterMessage>;
  GRAPH_QUEUE: Queue<GraphQueueMessage>;  // Graph edge signal queue
  WEBHOOK_DLQ: Queue<WebhookDeadLetterMessage>;  // Failed webhook delivery queue

  // Durable Objects
  ORDERBOOK_MANAGER: DurableObjectNamespace;
  TRIGGER_EVENT_BUFFER: DurableObjectNamespace;
  GRAPH_MANAGER: DurableObjectNamespace;  // Market graph manager

  // Environment Variables
  GAMMA_API_URL: string;
  CLOB_WSS_URL: string;
  SNAPSHOT_INTERVAL_MS: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_TOKEN: string;
  VITE_DASHBOARD_API_KEY: string;  // Required key for dashboard API access
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
  description: string;
  category: string;
}

export interface MarketEventRecord {
  event_id: string;
  market_id: string; // Foreign key to MarketMetadataRecord.id
  title: string;
  slug: string;
  description: string;
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

// Webhook Dead Letter Queue message for failed webhook delivery
export interface WebhookDeadLetterMessage {
  trigger_id: string;
  webhook_url: string;
  event: unknown;
  failed_at: number;
  reason: string;
  retry_count: number;
}
