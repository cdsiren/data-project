import { memo } from "react";
import type { TriggerType } from "@/types";
import {
  TrendingUp,
  TrendingDown,
  ArrowLeftRight,
  AlertTriangle,
  Scale,
  Layers,
  Activity,
  XCircle,
  CircleDollarSign,
  Zap,
  Target,
  ArrowUpDown,
  Clock,
  Gauge,
  Waves,
  Crosshair,
  Users,
  type LucideIcon,
} from "lucide-react";

interface TriggerTypeBadgeProps {
  type: TriggerType;
  showLabel?: boolean;
}

interface TriggerConfig {
  icon: LucideIcon;
  color: string;
  bgColor: string;
  label: string;
  description: string;
}

export const TRIGGER_CONFIG: Record<TriggerType, TriggerConfig> = {
  PRICE_ABOVE: {
    icon: TrendingUp,
    color: "text-blue-400",
    bgColor: "bg-blue-600/20",
    label: "Price Above",
    description: "Fires when price crosses above threshold",
  },
  PRICE_BELOW: {
    icon: TrendingDown,
    color: "text-blue-400",
    bgColor: "bg-blue-600/20",
    label: "Price Below",
    description: "Fires when price drops below threshold",
  },
  SPREAD_NARROW: {
    icon: ArrowLeftRight,
    color: "text-green-400",
    bgColor: "bg-green-600/20",
    label: "Spread Narrow",
    description: "Good liquidity - spread below threshold",
  },
  SPREAD_WIDE: {
    icon: ArrowLeftRight,
    color: "text-yellow-400",
    bgColor: "bg-yellow-600/20",
    label: "Spread Wide",
    description: "Poor liquidity - spread above threshold",
  },
  IMBALANCE_BID: {
    icon: Scale,
    color: "text-purple-400",
    bgColor: "bg-purple-600/20",
    label: "Imbalance Bid",
    description: "Book imbalance favors bids",
  },
  IMBALANCE_ASK: {
    icon: Scale,
    color: "text-purple-400",
    bgColor: "bg-purple-600/20",
    label: "Imbalance Ask",
    description: "Book imbalance favors asks",
  },
  SIZE_SPIKE: {
    icon: Layers,
    color: "text-orange-400",
    bgColor: "bg-orange-600/20",
    label: "Size Spike",
    description: "Large size at top of book",
  },
  PRICE_MOVE: {
    icon: Activity,
    color: "text-orange-400",
    bgColor: "bg-orange-600/20",
    label: "Price Move",
    description: "Significant price movement in window",
  },
  CROSSED_BOOK: {
    icon: XCircle,
    color: "text-red-400",
    bgColor: "bg-red-600/20",
    label: "Crossed Book",
    description: "Bid >= Ask (arbitrage opportunity)",
  },
  EMPTY_BOOK: {
    icon: AlertTriangle,
    color: "text-red-400",
    bgColor: "bg-red-600/20",
    label: "Empty Book",
    description: "No liquidity on both sides",
  },
  VOLATILITY_SPIKE: {
    icon: Waves,
    color: "text-cyan-400",
    bgColor: "bg-cyan-600/20",
    label: "Volatility Spike",
    description: "Realized volatility exceeds threshold",
  },
  MICROPRICE_DIVERGENCE: {
    icon: Target,
    color: "text-cyan-400",
    bgColor: "bg-cyan-600/20",
    label: "Microprice Div",
    description: "Microprice diverges from mid (directional signal)",
  },
  IMBALANCE_SHIFT: {
    icon: ArrowUpDown,
    color: "text-teal-400",
    bgColor: "bg-teal-600/20",
    label: "Imbalance Shift",
    description: "Rapid change in book imbalance",
  },
  MID_PRICE_TREND: {
    icon: TrendingUp,
    color: "text-teal-400",
    bgColor: "bg-teal-600/20",
    label: "Mid Trend",
    description: "Consecutive price moves in same direction",
  },
  QUOTE_VELOCITY: {
    icon: Gauge,
    color: "text-indigo-400",
    bgColor: "bg-indigo-600/20",
    label: "Quote Velocity",
    description: "High BBO update rate (competitive pressure)",
  },
  STALE_QUOTE: {
    icon: Clock,
    color: "text-slate-400",
    bgColor: "bg-slate-600/20",
    label: "Stale Quote",
    description: "No BBO update (market halt/data issue)",
  },
  LARGE_FILL: {
    icon: Zap,
    color: "text-rose-400",
    bgColor: "bg-rose-600/20",
    label: "Large Fill",
    description: "Significant size removed (whale activity)",
  },
  ARBITRAGE_BUY: {
    icon: CircleDollarSign,
    color: "text-amber-400",
    bgColor: "bg-amber-600/20",
    label: "Arb Buy",
    description: "YES+NO asks < 1 (buy both for profit)",
  },
  ARBITRAGE_SELL: {
    icon: CircleDollarSign,
    color: "text-amber-400",
    bgColor: "bg-amber-600/20",
    label: "Arb Sell",
    description: "YES+NO bids > 1 (sell both for profit)",
  },
  MULTI_OUTCOME_ARBITRAGE: {
    icon: Users,
    color: "text-pink-400",
    bgColor: "bg-pink-600/20",
    label: "Multi-Arb",
    description: "N-outcome arbitrage opportunity",
  },
  CRYPTO_PRICE_ARB: {
    icon: Activity,
    color: "text-emerald-400",
    bgColor: "bg-emerald-600/20",
    label: "Crypto Arb",
    description: "Crypto price mispricing vs external feed",
  },
};

// Default config for unknown trigger types
const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  icon: Crosshair,
  color: "text-gray-400",
  bgColor: "bg-gray-600/20",
  label: "Unknown",
  description: "Unknown trigger type",
};

export const TriggerTypeBadge = memo<TriggerTypeBadgeProps>(
  function TriggerTypeBadge({ type, showLabel = false }) {
    const config = TRIGGER_CONFIG[type] ?? DEFAULT_TRIGGER_CONFIG;
    const Icon = config.icon;

    return (
      <div
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md ${config.bgColor}`}
        title={`${config.label}: ${config.description}`}
        role="status"
        aria-label={`${config.label} trigger`}
      >
        <Icon className={`h-4 w-4 ${config.color}`} aria-hidden="true" />
        {showLabel && (
          <span className={`text-xs font-medium ${config.color}`}>
            {config.label}
          </span>
        )}
      </div>
    );
  }
);

export const TriggerLegend = memo(function TriggerLegend() {
  const categories = [
    {
      name: "Price",
      types: ["PRICE_ABOVE", "PRICE_BELOW"] as TriggerType[],
    },
    {
      name: "Spread",
      types: ["SPREAD_NARROW", "SPREAD_WIDE"] as TriggerType[],
    },
    {
      name: "Imbalance",
      types: [
        "IMBALANCE_BID",
        "IMBALANCE_ASK",
        "IMBALANCE_SHIFT",
      ] as TriggerType[],
    },
    {
      name: "Activity",
      types: ["SIZE_SPIKE", "PRICE_MOVE", "LARGE_FILL"] as TriggerType[],
    },
    {
      name: "HFT/MM",
      types: [
        "VOLATILITY_SPIKE",
        "MICROPRICE_DIVERGENCE",
        "MID_PRICE_TREND",
        "QUOTE_VELOCITY",
      ] as TriggerType[],
    },
    {
      name: "Risk",
      types: ["CROSSED_BOOK", "EMPTY_BOOK", "STALE_QUOTE"] as TriggerType[],
    },
    {
      name: "Arbitrage",
      types: [
        "ARBITRAGE_BUY",
        "ARBITRAGE_SELL",
        "MULTI_OUTCOME_ARBITRAGE",
        "CRYPTO_PRICE_ARB",
      ] as TriggerType[],
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 text-xs">
      {categories.map((category) => (
        <div key={category.name}>
          <div className="text-[hsl(var(--muted-foreground))] font-semibold mb-1.5">
            {category.name}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {category.types.map((type) => {
              const config = TRIGGER_CONFIG[type];
              const Icon = config.icon;
              return (
                <div
                  key={type}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${config.bgColor}`}
                  title={config.description}
                >
                  <Icon
                    className={`h-3 w-3 ${config.color}`}
                    aria-hidden="true"
                  />
                  <span className={`text-[10px] ${config.color}`}>
                    {config.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
});
