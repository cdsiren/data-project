import { memo } from "react";
import type { TriggerEvent } from "@/types";
import type { ShardMetrics } from "@/types/metrics";
import { EventDetailSection } from "./EventDetailSection";
import { ShardMetricsPanel } from "./ShardMetricsPanel";
import { getShardForCondition } from "@/lib/shard-utils";

interface TriggerEventDetailsProps {
  event: TriggerEvent;
  getShardMetrics: (shardName: string) => ShardMetrics | null;
}

export const TriggerEventDetails = memo<TriggerEventDetailsProps>(
  function TriggerEventDetails({ event, getShardMetrics }) {
    const shardName = getShardForCondition(event.condition_id);
    const shardMetrics = getShardMetrics(shardName);

    return (
      <div className="px-4 py-4 bg-[hsl(var(--background))] border-t border-[hsl(var(--border))]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: Event Details */}
          <div className="p-4 bg-[hsl(var(--muted))]/30 rounded-lg border border-[hsl(var(--border))]">
            <h3 className="text-sm font-semibold mb-3">Event Details</h3>
            <EventDetailSection event={event} />
          </div>

          {/* Right: Shard Metrics */}
          <div>
            <ShardMetricsPanel shardName={shardName} metrics={shardMetrics} />
          </div>
        </div>
      </div>
    );
  }
);
