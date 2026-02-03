import { memo } from "react";
import type { ShardMetrics, HealthStatus } from "@/types/metrics";
import { HEALTH_THRESHOLDS } from "@/types/metrics";
import { HealthIndicator } from "@/components/metrics/HealthIndicator";

interface ShardMetricsPanelProps {
  shardName: string;
  metrics: ShardMetrics | null;
}

interface LatencyBarProps {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}

const LatencyBar = memo<LatencyBarProps>(function LatencyBar({
  label,
  value,
  maxValue,
  color,
}) {
  const percentage = Math.min((value / maxValue) * 100, 100);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
        <span className="font-mono">
          {value < 1 ? `${(value * 1000).toFixed(0)}us` : `${value.toFixed(1)}ms`}
        </span>
      </div>
      <div className="h-2 bg-[hsl(var(--muted))] rounded-full overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
});

function getShardHealthStatus(metrics: ShardMetrics | null): HealthStatus {
  if (!metrics) return "unknown";
  const p95 = metrics.latency.processing.p95_ms;
  if (p95 > HEALTH_THRESHOLDS.P95_DEGRADED) return "critical";
  if (p95 > HEALTH_THRESHOLDS.P95_HEALTHY) return "degraded";
  return "healthy";
}

export const ShardMetricsPanel = memo<ShardMetricsPanelProps>(
  function ShardMetricsPanel({ shardName, metrics }) {
    if (!metrics) {
      return (
        <div className="p-4 bg-[hsl(var(--muted))]/30 rounded-lg border border-[hsl(var(--border))]">
          <h4 className="text-sm font-semibold mb-2">{shardName}</h4>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            No metrics available
          </p>
        </div>
      );
    }

    const { latency, triggers } = metrics;
    const healthStatus = getShardHealthStatus(metrics);

    // Max value for bar charts (10ms gives good visual range)
    const maxLatency = 10;

    return (
      <div className="p-4 bg-[hsl(var(--muted))]/30 rounded-lg border border-[hsl(var(--border))]">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-semibold">{shardName}</h4>
          <HealthIndicator status={healthStatus} size="sm" />
        </div>

        {/* Processing Latency Section */}
        <div className="space-y-3 mb-4">
          <h5 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
            Processing Latency
          </h5>
          <LatencyBar
            label="P50"
            value={latency.processing.p50_ms}
            maxValue={maxLatency}
            color="bg-green-500"
          />
          <LatencyBar
            label="P95"
            value={latency.processing.p95_ms}
            maxValue={maxLatency}
            color="bg-yellow-500"
          />
          <LatencyBar
            label="P99"
            value={latency.processing.p99_ms}
            maxValue={maxLatency}
            color="bg-red-500"
          />
        </div>

        {/* Ingestion Latency Section (time to receive orderbook data) */}
        <div className="space-y-3 mb-4">
          <h5 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
            Ingestion Latency
          </h5>
          <LatencyBar
            label="P50"
            value={latency.total.p50_ms}
            maxValue={maxLatency}
            color="bg-blue-500"
          />
          <LatencyBar
            label="P95"
            value={latency.total.p95_ms}
            maxValue={maxLatency}
            color="bg-orange-500"
          />
          <LatencyBar
            label="P99"
            value={latency.total.p99_ms}
            maxValue={maxLatency}
            color="bg-purple-500"
          />
        </div>

        {/* Stats */}
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-[hsl(var(--muted-foreground))]">
              Triggers Registered
            </span>
            <span className="font-mono">{triggers.registered}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[hsl(var(--muted-foreground))]">
              Unique Assets
            </span>
            <span className="font-mono">{triggers.by_asset}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[hsl(var(--muted-foreground))]">Samples</span>
            <span className="font-mono">
              {latency.processing.sample_count.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    );
  }
);
