import { memo } from "react";
import { Activity, Wifi, WifiOff, Server, Clock } from "lucide-react";
import { useMetrics } from "@/hooks/useMetrics";
import { HealthDot } from "@/components/metrics/HealthIndicator";
import { formatMs } from "@/lib/format-utils";

interface HeaderProps {
  connected: boolean;
}

export const Header = memo<HeaderProps>(function Header({ connected }) {
  const { data, healthyShardCount, totalShardCount, healthStatus } =
    useMetrics();

  const p95 = data?.aggregated?.processing.p95_ms;

  return (
    <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        {/* Left: Logo */}
        <div className="flex items-center gap-2">
          <Activity className="h-6 w-6 text-white" aria-hidden="true" />
          <h1 className="text-xl font-bold">Indication</h1>
        </div>

        {/* Right: Metrics + Connection Status */}
        <div className="flex items-center gap-4">
          {/* Metrics Display */}
          {data && (
            <div className="hidden sm:flex items-center gap-3 text-sm text-[hsl(var(--muted-foreground))] border-r border-[hsl(var(--border))] pr-4">
              <div className="flex items-center gap-1.5" title="P95 Processing Latency">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">{formatMs(p95)}</span>
              </div>

              <div className="flex items-center gap-1.5" title="Shard Health">
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">
                  {healthyShardCount}/{totalShardCount}
                </span>
                <HealthDot status={healthStatus} />
              </div>
            </div>
          )}

          {/* Connection Status */}
          <div
            className="flex items-center gap-2"
            role="status"
            aria-live="polite"
          >
            {connected ? (
              <>
                <Wifi className="h-4 w-4 text-green-500" aria-hidden="true" />
                <span className="text-sm text-green-500">Live</span>
              </>
            ) : (
              <>
                <WifiOff className="h-4 w-4 text-red-500" aria-hidden="true" />
                <span className="text-sm text-red-500">Disconnected</span>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
});
