import { useQuery } from "@tanstack/react-query";
import { useMemo, useCallback } from "react";
import { fetchMetrics } from "@/lib/api";
import { METRICS_CONFIG } from "@/lib/constants";
import type {
  MetricsResponse,
  HealthStatus,
  ShardMetrics,
} from "@/types/metrics";
import { HEALTH_THRESHOLDS } from "@/types/metrics";

/**
 * Compute overall system health status from metrics
 */
function computeHealthStatus(data: MetricsResponse | undefined): HealthStatus {
  if (!data || !data.aggregated) {
    return "unknown";
  }

  const { processing, sample_count } = data.aggregated;
  const p95 = processing.p95_ms;
  const healthyShards = data.shards.filter(
    (s) => s.metrics && !s.error
  ).length;

  // Critical: No samples (system not processing) OR P95 > 15ms OR fewer than 20 healthy shards
  if (
    sample_count === 0 ||
    p95 > HEALTH_THRESHOLDS.P95_DEGRADED ||
    healthyShards < HEALTH_THRESHOLDS.SHARDS_DEGRADED
  ) {
    return "critical";
  }

  // Degraded: P95 5-15ms OR 20-23 healthy shards
  if (
    p95 > HEALTH_THRESHOLDS.P95_HEALTHY ||
    healthyShards < HEALTH_THRESHOLDS.SHARDS_HEALTHY
  ) {
    return "degraded";
  }

  return "healthy";
}

/**
 * Get metrics for a specific shard by name
 */
function getShardMetrics(
  data: MetricsResponse | undefined,
  shardName: string
): ShardMetrics | null {
  if (!data) return null;
  const shard = data.shards.find((s) => s.shard === shardName);
  return shard?.metrics ?? null;
}

export interface UseMetricsResult {
  data: MetricsResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  healthStatus: HealthStatus;
  healthyShardCount: number;
  totalShardCount: number;
  getShardMetrics: (shardName: string) => ShardMetrics | null;
}

/**
 * Hook to fetch system metrics with 30s polling
 */
export function useMetrics(): UseMetricsResult {
  const { data, isLoading, error } = useQuery({
    queryKey: ["metrics"],
    queryFn: fetchMetrics,
    refetchInterval: METRICS_CONFIG.POLL_INTERVAL_MS,
    staleTime: METRICS_CONFIG.STALE_MS,
  });

  const healthStatus = useMemo(() => computeHealthStatus(data), [data]);

  const healthyShardCount = useMemo(() => {
    if (!data) return 0;
    return data.shards.filter((s) => s.metrics && !s.error).length;
  }, [data]);

  const totalShardCount = useMemo(() => {
    return data?.shard_count ?? HEALTH_THRESHOLDS.TOTAL_SHARDS;
  }, [data]);

  const getShardMetricsFn = useCallback(
    (shardName: string) => getShardMetrics(data, shardName),
    [data]
  );

  return {
    data,
    isLoading,
    error: error as Error | null,
    healthStatus,
    healthyShardCount,
    totalShardCount,
    getShardMetrics: getShardMetricsFn,
  };
}
