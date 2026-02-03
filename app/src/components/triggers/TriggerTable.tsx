import { useEffect, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TriggerLegend } from "./TriggerTypeBadge";
import { TriggerTableRow } from "./TriggerTableRow";
import { useMetrics } from "@/hooks/useMetrics";
import type { TriggerEvent } from "@/types";
import {
  AlertCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Info,
  Activity,
} from "lucide-react";

interface TriggerTableProps {
  events: TriggerEvent[];
  connected: boolean;
  error: string | null;
  onReconnect: () => void;
}

export function TriggerTable({
  events,
  connected,
  error,
  onReconnect,
}: TriggerTableProps) {
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const [showLegend, setShowLegend] = useState(false);
  const { getShardMetrics } = useMetrics();

  useEffect(() => {
    if (tableBodyRef.current && events.length > 0) {
      tableBodyRef.current.scrollTop = 0;
    }
  }, [events.length]);

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle>Trigger Events</CardTitle>
            <span className="text-sm text-[hsl(var(--muted-foreground))]">
              ({events.length} events)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLegend(!showLegend)}
              className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
              title="Toggle trigger legend"
              aria-label="Toggle trigger type legend"
              aria-expanded={showLegend}
              aria-controls="trigger-legend"
            >
              <Info className="h-4 w-4" aria-hidden="true" />
              Legend
              {showLegend ? (
                <ChevronUp className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              )}
            </button>
            {!connected && error && (
              <button
                onClick={onReconnect}
                className="flex items-center gap-1 text-sm text-yellow-500 hover:text-yellow-400"
                aria-label="Reconnect to event stream"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Reconnect
              </button>
            )}
          </div>
        </div>
        {error && (
          <div
            className="flex items-center gap-2 text-sm text-yellow-500 mt-2"
            role="alert"
          >
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            {error}
          </div>
        )}

        {showLegend && (
          <div
            id="trigger-legend"
            className="mt-3 p-3 rounded-lg bg-[hsl(var(--muted))]/50 border border-[hsl(var(--border))]"
            role="region"
            aria-label="Trigger type legend"
          >
            <TriggerLegend />
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div className="h-full overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-[hsl(var(--card))] z-10">
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead className="w-[50px]">Type</TableHead>
                <TableHead className="w-[90px]">Time</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Market</TableHead>
                <TableHead className="text-right">Mid</TableHead>
                <TableHead className="text-right">Spread</TableHead>
                <TableHead className="text-right">Processing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody ref={tableBodyRef}>
              {events.length === 0 ? (
                !connected ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-4">
                      <div className="space-y-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center py-8 text-[hsl(var(--muted-foreground))]"
                    >
                      <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      Waiting for trigger events...
                    </TableCell>
                  </TableRow>
                )
              ) : (
                events.map((event, index) => {
                  const key = `${index}-${event.trigger_id}-${event.asset_id}-${event.fired_at}`;
                  return (
                    <TriggerTableRow
                      key={key}
                      event={event}
                      getShardMetrics={getShardMetrics}
                    />
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
