import { memo } from "react";
import type { TriggerEvent } from "@/types";
import {
  formatTime,
  formatPrice,
  formatSpread,
  formatLatency,
} from "@/lib/chart-utils";
import { TriggerTypeBadge, TRIGGER_CONFIG } from "./TriggerTypeBadge";

interface EventDetailSectionProps {
  event: TriggerEvent;
}

interface DetailRowProps {
  label: string;
  value: string | number | null | undefined;
  className?: string;
}

const DetailRow = memo<DetailRowProps>(function DetailRow({
  label,
  value,
  className = "",
}) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex justify-between text-sm">
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      <span className={`font-mono ${className}`}>{value}</span>
    </div>
  );
});

interface DetailSectionProps {
  title: string;
  children: React.ReactNode;
}

const DetailSection = memo<DetailSectionProps>(function DetailSection({
  title,
  children,
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
        {title}
      </h4>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
});

export const EventDetailSection = memo<EventDetailSectionProps>(
  function EventDetailSection({ event }) {
    const hasArbitrage =
      event.counterpart_asset_id ||
      event.sum_of_asks !== undefined ||
      event.potential_profit_bps !== undefined;

    const hasHFT =
      event.volatility !== undefined ||
      event.microprice !== undefined ||
      event.imbalance_delta !== undefined ||
      event.consecutive_moves !== undefined ||
      event.updates_per_second !== undefined;

    const triggerConfig = TRIGGER_CONFIG[event.trigger_type];

    return (
      <div className="space-y-4">
        {/* Event Type Header */}
        <div className="flex items-start gap-3 pb-2 border-b border-[hsl(var(--border))]">
          <TriggerTypeBadge type={event.trigger_type} showLabel />
          <p className="text-sm text-[hsl(var(--muted-foreground))] flex-1">
            {triggerConfig?.description ?? "Unknown trigger type"}
          </p>
        </div>

        {/* Core Details */}
        <DetailSection title="Core">
          <DetailRow label="Trigger ID" value={event.trigger_id} />
          <DetailRow label="Fired At" value={formatTime(event.fired_at)} />
          <DetailRow
            label="Total Latency"
            value={formatLatency(event.total_latency_us)}
          />
          <DetailRow
            label="Processing"
            value={formatLatency(event.processing_latency_us)}
            className="text-green-400"
          />
        </DetailSection>

        {/* Order Book */}
        <DetailSection title="Order Book">
          <DetailRow
            label="Bid"
            value={
              event.best_bid !== null
                ? `${formatPrice(event.best_bid)} (${event.bid_size ?? "-"})`
                : null
            }
            className="text-green-400"
          />
          <DetailRow
            label="Ask"
            value={
              event.best_ask !== null
                ? `${formatPrice(event.best_ask)} (${event.ask_size ?? "-"})`
                : null
            }
            className="text-red-400"
          />
          <DetailRow
            label="Mid"
            value={formatPrice(
              event.best_bid !== null && event.best_ask !== null
                ? (event.best_bid + event.best_ask) / 2
                : null
            )}
          />
          <DetailRow label="Spread" value={formatSpread(event.spread_bps)} />
        </DetailSection>

        {/* Trigger Condition */}
        <DetailSection title="Trigger Condition">
          <DetailRow label="Type" value={event.trigger_type} />
          <DetailRow
            label="Threshold"
            value={
              event.threshold !== undefined
                ? event.threshold.toLocaleString()
                : null
            }
          />
          <DetailRow
            label="Actual"
            value={
              event.actual_value !== undefined
                ? event.actual_value.toLocaleString()
                : null
            }
          />
        </DetailSection>

        {/* Arbitrage (if present) */}
        {hasArbitrage && (
          <DetailSection title="Arbitrage">
            {event.counterpart_asset_id && (
              <>
                <DetailRow
                  label="Counterpart"
                  value={`${event.counterpart_asset_id.slice(0, 8)}...`}
                />
                <DetailRow
                  label="CP Bid"
                  value={formatPrice(event.counterpart_best_bid ?? null)}
                  className="text-green-400"
                />
                <DetailRow
                  label="CP Ask"
                  value={formatPrice(event.counterpart_best_ask ?? null)}
                  className="text-red-400"
                />
              </>
            )}
            <DetailRow
              label="Sum Asks"
              value={
                event.sum_of_asks !== undefined
                  ? `${(event.sum_of_asks * 100).toFixed(2)}c`
                  : null
              }
            />
            <DetailRow
              label="Sum Bids"
              value={
                event.sum_of_bids !== undefined
                  ? `${(event.sum_of_bids * 100).toFixed(2)}c`
                  : null
              }
            />
            <DetailRow
              label="Profit"
              value={
                event.potential_profit_bps !== undefined
                  ? `${event.potential_profit_bps} bps`
                  : null
              }
              className="text-yellow-400"
            />
          </DetailSection>
        )}

        {/* HFT (if present) */}
        {hasHFT && (
          <DetailSection title="HFT Signals">
            <DetailRow
              label="Volatility"
              value={
                event.volatility !== undefined
                  ? `${(event.volatility * 100).toFixed(2)}%`
                  : null
              }
            />
            <DetailRow
              label="Microprice"
              value={formatPrice(event.microprice ?? null)}
            />
            <DetailRow
              label="Divergence"
              value={
                event.microprice_divergence_bps !== undefined
                  ? `${event.microprice_divergence_bps} bps`
                  : null
              }
            />
            <DetailRow
              label="Imbalance Delta"
              value={
                event.imbalance_delta !== undefined
                  ? event.imbalance_delta.toFixed(3)
                  : null
              }
            />
            {event.trend_direction && (
              <DetailRow
                label="Trend"
                value={`${event.trend_direction} (${event.consecutive_moves ?? 0} moves)`}
                className={
                  event.trend_direction === "UP"
                    ? "text-green-400"
                    : "text-red-400"
                }
              />
            )}
            <DetailRow
              label="Quote Velocity"
              value={
                event.updates_per_second !== undefined
                  ? `${event.updates_per_second}/s`
                  : null
              }
            />
            <DetailRow
              label="Stale"
              value={
                event.stale_ms !== undefined ? `${event.stale_ms}ms` : null
              }
            />
          </DetailSection>
        )}

        {/* Integrity */}
        <DetailSection title="Integrity">
          <DetailRow label="Book Hash" value={`${event.book_hash.slice(0, 12)}...`} />
          <DetailRow label="Sequence" value={event.sequence_number} />
        </DetailSection>
      </div>
    );
  }
);
