// src/services/graph/types.ts
// Type definitions for the multi-market graph system

import type {
  Trigger,
  TriggerCondition,
  TriggerEvent,
  CompoundTrigger,
  CompoundMode,
  CompoundCondition,
  CompoundTriggerState,
  CompoundTriggerEvent,
} from "../../core/triggers";
import type { MarketSource } from "../../core/enums";

// Re-export compound trigger types for convenience
export type {
  CompoundTrigger,
  CompoundMode,
  CompoundCondition,
  CompoundTriggerState,
  CompoundTriggerEvent,
};

// Re-export isCompoundTrigger from core
export { isCompoundTrigger } from "../../core/triggers";

// ============================================================
// Edge Types and Graph Structure
// ============================================================

/**
 * Types of edges in the market graph.
 * Each type has different semantics for weight interpretation:
 * - correlation: +weight (0 to 1, positive correlation strength)
 * - hedge: -weight (-1 to 0, stored as negative for Bellman-Ford)
 * - arbitrage: log(1 - spread) (negative when profitable)
 * - causal: +weight (0 to 1, based on tag overlap/metadata)
 */
export type EdgeType = "correlation" | "hedge" | "causal" | "arbitrage";

/**
 * Sources of edge signals.
 * Determines signal weighting during aggregation.
 */
export type SignalSource =
  | "user_analysis"      // User created analysis linking markets
  | "user_trigger"       // User created compound trigger
  | "trigger_fire"       // Compound trigger fired successfully
  | "trigger_miss"       // Compound trigger missed (weak negative signal)
  | "cron_correlation"   // Daily correlation cron job
  | "metadata_tag"       // Shared tags/metadata between markets
  | "bellman_ford_cycle"; // Detected negative cycle

/**
 * Raw edge signal stored in ClickHouse.
 * Append-only log of all signals contributing to graph edges.
 */
export interface EdgeSignal {
  market_a: string;
  market_b: string;
  edge_type: EdgeType;
  signal_source: SignalSource;
  user_id: string;
  strength: number;
  metadata: string;
  created_at: number; // Unix timestamp in microseconds
}

/**
 * Aggregated edge in the graph.
 * Computed from signals with decay during 15-min rebuild.
 */
export interface GraphEdge {
  market_a: string;
  market_b: string;
  edge_type: EdgeType;
  weight: number;
  user_count: number;
  signal_count: number;
  last_signal_at: number;
}

/**
 * Neighbor entry in adjacency list.
 * Used for 1-hop lookups in the hot path.
 */
export interface GraphNeighbor {
  market_id: string;
  edge_type: EdgeType;
  weight: number;
  user_count: number;
}

/**
 * Full adjacency list for a market.
 * Cached in KV with key: graph:neighbors:{market_id}
 */
export interface AdjacencyList {
  market_id: string;
  neighbors: GraphNeighbor[];
  updated_at: number;
}

// ============================================================
// Graph Algorithms
// ============================================================

/**
 * Path found during BFS traversal.
 */
export interface ArbitragePath {
  markets: string[];
  weights: number[];
  total_weight: number;
  opportunity_bps: number;
  edge_types: EdgeType[];
}

/**
 * Negative cycle detected by Bellman-Ford.
 * Represents potential arbitrage opportunity.
 */
export interface NegativeCycle {
  cycle_id: string;
  markets: string[];
  total_weight: number;  // Negative = arbitrage opportunity
  opportunity_type: "hedge_loop" | "inverse_correlation";
  detected_at: number;
}

/**
 * Result of shortest path calculation.
 */
export interface ShortestPath {
  from: string;
  to: string;
  path: string[];
  total_weight: number;
  edge_types: EdgeType[];
}

// ============================================================
// Cross-Shard Coordination
// ============================================================

/**
 * Notification published to KV for cross-shard trigger coordination.
 */
export interface CrossShardTriggerNotification {
  trigger_id: string;
  shard_id: string;
  condition_index: number;
  market_id: string;
  asset_id: string;
  fired: boolean;
  actual_value: number;
  timestamp: number;
  expires_at: number;
}

/**
 * Aggregated cross-shard state for a compound trigger.
 */
export interface CrossShardTriggerState {
  trigger_id: string;
  shards: Map<string, CrossShardTriggerNotification>;
  last_aggregation: number;
}

// ============================================================
// Queue Messages
// ============================================================

/**
 * Message sent to GRAPH_QUEUE for edge signal processing.
 */
export interface EdgeSignalMessage {
  type: "edge_signal";
  market_a: string;
  market_b: string;
  edge_type: EdgeType;
  signal_source: SignalSource;
  user_id: string;
  strength: number;
  metadata: Record<string, unknown>;
}

/**
 * Message sent when a negative cycle is detected.
 */
export interface NegativeCycleMessage {
  type: "negative_cycle_detected";
  cycle: string[];
  weight: number;
  opportunity_type: "hedge_loop" | "inverse_correlation";
}

/**
 * Union of all graph queue message types.
 */
export type GraphQueueMessage = EdgeSignalMessage | NegativeCycleMessage;

// ============================================================
// API Response Types
// ============================================================

/**
 * Response for graph neighbor queries.
 */
export interface NeighborResponse {
  market_id: string;
  neighbors: GraphNeighbor[];
  cached: boolean;
  updated_at: number;
}

/**
 * Response for path queries.
 */
export interface PathResponse {
  from: string;
  to: string;
  path: ShortestPath | null;
  found: boolean;
}

/**
 * Response for arbitrage path queries.
 */
export interface ArbitrageResponse {
  market_id: string;
  paths: ArbitragePath[];
  count: number;
}

/**
 * Response for cycle detection queries.
 */
export interface CyclesResponse {
  cycles: NegativeCycle[];
  count: number;
  last_detection: number;
}

/**
 * Suggestion for related markets.
 */
export interface MarketSuggestion {
  market_id: string;
  edge_type: EdgeType;
  weight: number;
  user_count: number;
  reason: string;
  market?: {
    title?: string;
    question?: string;
    end_date?: string;
  };
}

/**
 * Response for market suggestions.
 */
export interface SuggestionsResponse {
  market_id: string;
  suggestions: MarketSuggestion[];
  community_signal: string;
}

// ============================================================
// Graph Manager DO Types
// ============================================================

/**
 * State stored in GraphManager DO.
 */
export interface GraphManagerState {
  /** Full adjacency list: market_id -> neighbors */
  adjacencyList: Map<string, GraphNeighbor[]>;
  /** Last rebuild timestamp */
  lastRebuild: number;
  /** Total edge count */
  edgeCount: number;
  /** Total market count */
  marketCount: number;
  /** Detected cycles (cached) */
  cachedCycles: NegativeCycle[];
  /** Last cycle detection run */
  lastCycleDetection: number;
}

/**
 * Options for graph queries.
 */
export interface GraphQueryOptions {
  /** Maximum depth for BFS */
  maxDepth?: number;
  /** Minimum weight threshold */
  minWeight?: number;
  /** Edge types to include */
  edgeTypes?: EdgeType[];
  /** Maximum results to return */
  limit?: number;
}

/**
 * Options for neighbor sorting.
 */
export interface NeighborSortOptions {
  minWeight?: number;
  minUserCount?: number;
  limit?: number;
  edgeTypes?: EdgeType[];
}

// ============================================================
// Helper Type Guards
// ============================================================

/**
 * Type guard for EdgeSignalMessage.
 */
export function isEdgeSignalMessage(msg: GraphQueueMessage): msg is EdgeSignalMessage {
  return msg.type === "edge_signal";
}

/**
 * Type guard for NegativeCycleMessage.
 */
export function isNegativeCycleMessage(msg: GraphQueueMessage): msg is NegativeCycleMessage {
  return msg.type === "negative_cycle_detected";
}
