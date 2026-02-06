// Dashboard types - shared with backend

/**
 * Trigger types from backend
 */
export type TriggerType =
  // Generic triggers
  | "PRICE_ABOVE"
  | "PRICE_BELOW"
  | "SPREAD_NARROW"
  | "SPREAD_WIDE"
  | "IMBALANCE_BID"
  | "IMBALANCE_ASK"
  | "SIZE_SPIKE"
  | "PRICE_MOVE"
  | "CROSSED_BOOK"
  | "EMPTY_BOOK"
  // HFT / Market Making triggers
  | "VOLATILITY_SPIKE"
  | "MICROPRICE_DIVERGENCE"
  | "IMBALANCE_SHIFT"
  | "MID_PRICE_TREND"
  | "QUOTE_VELOCITY"
  | "STALE_QUOTE"
  | "LARGE_FILL"
  // Prediction market triggers
  | "ARBITRAGE_BUY"
  | "ARBITRAGE_SELL"
  | "MULTI_OUTCOME_ARBITRAGE";

/**
 * Trigger event from SSE stream
 */
export interface TriggerEvent {
  trigger_id: string;
  trigger_type: TriggerType;
  asset_id: string;
  condition_id: string;
  fired_at: number;

  // Dual latency tracking
  total_latency_us: number; // includes network (source_ts → fired_at)
  processing_latency_us: number; // DO processing only (ingestion_ts → fired_at)

  best_bid: number | null;
  best_ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid_price: number | null;
  spread_bps: number | null;

  threshold: number;
  actual_value: number;

  // Arbitrage fields
  counterpart_asset_id?: string;
  counterpart_best_bid?: number | null;
  counterpart_best_ask?: number | null;
  sum_of_asks?: number;
  sum_of_bids?: number;
  potential_profit_bps?: number;

  // HFT trigger fields
  volatility?: number;
  microprice?: number;
  microprice_divergence_bps?: number;
  imbalance_delta?: number;
  previous_imbalance?: number;
  current_imbalance?: number;
  consecutive_moves?: number;
  trend_direction?: "UP" | "DOWN";
  updates_per_second?: number;
  stale_ms?: number;
  outcome_ask_sum?: number;
  outcome_count?: number;
  fill_notional?: number;
  fill_side?: "BID" | "ASK";
  size_delta?: number;

  book_hash: string;
  sequence_number: number;
  metadata?: Record<string, string>;
}

/**
 * Top activity market response
 */
export interface TopMarket {
  asset_id: string;
  condition_id: string;
  tick_count: number;
  question?: string;
}

/**
 * Top activity API response
 */
export interface TopActivityResponse {
  data: TopMarket | null;
  timestamp: string;
}
