export interface Env {
  MARKET_CACHE: KVNamespace;
  ORDERBOOK_STORAGE: R2Bucket;
  METADATA_QUEUE: Queue;
  SNAPSHOT_QUEUE: Queue;
  ORDERBOOK_MANAGER: DurableObjectNamespace;
  GAMMA_API_URL: string;
  CLOB_WSS_URL: string;
  SNAPSHOT_INTERVAL_MS: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_TOKEN: string;
}

export interface GoldskyTradeEvent {
  tx_hash: string;
  block_number: number;
  timestamp: number;
  token_id: string;
  maker: string;
  taker: string;
  side: 'BUY' | 'SELL';
  price: string;
  amount: string;
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
  condition_id: string;
  token_id: string;
}
