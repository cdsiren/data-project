// Metrics types for dashboard health monitoring

export interface LatencyStats {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
  sample_count: number;
}

export interface ShardMetrics {
  latency: {
    total: LatencyStats;
    processing: LatencyStats;
    window_ms: number;
  };
  triggers: {
    registered: number;
    by_asset: number;
  };
  shard: string;
}

export interface AggregatedMetrics {
  total: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    mean_ms: number;
  };
  processing: {
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    mean_ms: number;
  };
  sample_count: number;
  triggers_registered: number;
}

export interface ShardResult {
  shard: string;
  metrics?: ShardMetrics;
  error?: string;
}

export interface MetricsResponse {
  aggregated: AggregatedMetrics | null;
  shards: ShardResult[];
  shard_count: number;
  timestamp: string;
}

export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";

// Health thresholds
export const HEALTH_THRESHOLDS = {
  // P95 processing latency thresholds (ms)
  P95_HEALTHY: 5,
  P95_DEGRADED: 15,
  // Shard health thresholds
  SHARDS_HEALTHY: 24,
  SHARDS_DEGRADED: 20,
  TOTAL_SHARDS: 25,
} as const;
