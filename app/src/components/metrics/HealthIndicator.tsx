import { memo } from "react";
import type { HealthStatus } from "@/types/metrics";

interface HealthIndicatorProps {
  status: HealthStatus;
  showLabel?: boolean;
  size?: "sm" | "md";
}

const statusConfig: Record<
  HealthStatus,
  { color: string; label: string; bgColor: string }
> = {
  healthy: {
    color: "bg-green-500",
    bgColor: "bg-green-500/20",
    label: "Healthy",
  },
  degraded: {
    color: "bg-yellow-500",
    bgColor: "bg-yellow-500/20",
    label: "Degraded",
  },
  critical: {
    color: "bg-red-500",
    bgColor: "bg-red-500/20",
    label: "Critical",
  },
  unknown: {
    color: "bg-gray-500",
    bgColor: "bg-gray-500/20",
    label: "Unknown",
  },
};

export const HealthIndicator = memo<HealthIndicatorProps>(
  function HealthIndicator({ status, showLabel = true, size = "md" }) {
    const config = statusConfig[status];
    const dotSize = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";

    return (
      <div className="flex items-center gap-1.5">
        <span
          className={`${dotSize} rounded-full ${config.color} animate-pulse`}
          aria-hidden="true"
        />
        {showLabel && (
          <span
            className={`text-sm font-medium px-1.5 py-0.5 rounded ${config.bgColor}`}
          >
            {config.label}
          </span>
        )}
      </div>
    );
  }
);

export const HealthDot = memo<{ status: HealthStatus }>(function HealthDot({
  status,
}) {
  const config = statusConfig[status];
  return (
    <span
      className={`h-2 w-2 rounded-full ${config.color}`}
      aria-label={config.label}
    />
  );
});
