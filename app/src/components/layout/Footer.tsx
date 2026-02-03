import { memo } from "react";
import { useMetrics } from "@/hooks/useMetrics";
import { HealthIndicator } from "@/components/metrics/HealthIndicator";
import { HEALTH_THRESHOLDS } from "@/types/metrics";
import { Server, Activity, Clock, Database } from "lucide-react";
import { formatMs, formatCount } from "@/lib/format-utils";

export const Footer = memo(function Footer() {
  const {
    data,
    isLoading,
    healthStatus,
    healthyShardCount,
    totalShardCount,
  } = useMetrics();

  const sampleCount = data?.aggregated?.sample_count;
  const triggersRegistered = data?.aggregated?.triggers_registered;

  return (
    <footer className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="container mx-auto h-10 flex items-center justify-between px-4">
        {/* Left: Health Status */}
        <div className="flex items-center gap-4">
          <HealthIndicator status={healthStatus} size="sm" />
        </div>

        {/* Center: Metrics */}
        <div className="flex items-center gap-6 text-sm text-[hsl(var(--muted-foreground))]">
          {isLoading ? (
            <span className="animate-pulse">Loading metrics...</span>
          ) : (
            <>
              {/* Processing Latency */}
              <div
                className="flex items-center gap-1.5"
                title="P95 Processing Latency"
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">Proc: {formatMs(data?.aggregated?.processing.p95_ms)}</span>
              </div>

              {/* Total Latency (includes network) */}
              <div
                className="flex items-center gap-1.5"
                title="P95 Total Latency (includes network)"
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">Total: {formatMs(data?.aggregated?.total.p95_ms)}</span>
              </div>

              <div className="flex items-center gap-1.5" title="Sample Count">
                <Database className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">
                  Samples: {formatCount(sampleCount)}
                </span>
              </div>

              <div
                className="flex items-center gap-1.5"
                title="Registered Triggers"
              >
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">
                  Triggers: {formatCount(triggersRegistered)}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Right: Shard Count */}
        <div
          className="flex items-center gap-1.5 text-sm"
          title="Healthy Shards"
        >
          <Server className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          <span
            className={`font-mono ${
              healthyShardCount === totalShardCount
                ? "text-green-500"
                : healthyShardCount >= HEALTH_THRESHOLDS.SHARDS_DEGRADED
                ? "text-yellow-500"
                : "text-red-500"
            }`}
          >
            {healthyShardCount}/{totalShardCount} shards
          </span>
        </div>
      </div>
    </footer>
  );
});
