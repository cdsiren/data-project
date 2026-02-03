import { memo, useState, useCallback } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { TriggerTypeBadge } from "./TriggerTypeBadge";
import { TriggerEventDetails } from "./TriggerEventDetails";
import type { TriggerEvent } from "@/types";
import type { ShardMetrics } from "@/types/metrics";
import {
  formatTime,
  formatPrice,
  formatSpread,
  formatLatency,
} from "@/lib/chart-utils";
import { ChevronRight, ChevronDown } from "lucide-react";

interface TriggerTableRowProps {
  event: TriggerEvent;
  getShardMetrics: (shardName: string) => ShardMetrics | null;
}

const truncateId = (id: string, maxLen: number = 14): string => {
  if (id.length <= maxLen) return id;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
};

export const TriggerTableRow = memo<TriggerTableRowProps>(
  function TriggerTableRow({ event, getShardMetrics }) {
    const [expanded, setExpanded] = useState(false);

    const toggleExpand = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    return (
      <>
        <TableRow
          className="cursor-pointer hover:bg-[hsl(var(--muted))]/50 transition-colors"
          onClick={toggleExpand}
        >
          <TableCell className="w-8">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
            ) : (
              <ChevronRight className="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
            )}
          </TableCell>
          <TableCell>
            <TriggerTypeBadge type={event.trigger_type} />
          </TableCell>
          <TableCell className="font-mono text-xs">
            {formatTime(event.fired_at)}
          </TableCell>
          <TableCell className="font-mono text-xs" title={event.asset_id}>
            {truncateId(event.asset_id)}
          </TableCell>
          <TableCell
            className="font-mono text-xs text-[hsl(var(--muted-foreground))]"
            title={event.condition_id}
          >
            {truncateId(event.condition_id)}
          </TableCell>
          <TableCell className="text-right font-mono">
            {formatPrice(event.mid_price)}
          </TableCell>
          <TableCell className="text-right font-mono text-[hsl(var(--muted-foreground))]">
            {formatSpread(event.spread_bps)}
          </TableCell>
          <TableCell className="text-right font-mono text-xs text-[hsl(var(--muted-foreground))]">
            {formatLatency(event.processing_latency_us)}
          </TableCell>
        </TableRow>

        {expanded && (
          <TableRow>
            <TableCell colSpan={8} className="p-0">
              <TriggerEventDetails
                event={event}
                getShardMetrics={getShardMetrics}
              />
            </TableCell>
          </TableRow>
        )}
      </>
    );
  }
);
