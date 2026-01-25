import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  ColorType,
} from "lightweight-charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OHLCData } from "@/types";
import { transformToChartData } from "@/lib/chart-utils";
import { logger } from "@/lib/logger";
import { CHART_CONFIG } from "@/lib/constants";

interface CandlestickChartProps {
  data: OHLCData[] | undefined;
  loading: boolean;
  error: Error | null;
  title?: string;
  subtitle?: string;
}

export function CandlestickChart({
  data,
  loading,
  error,
  title = "Price Chart",
  subtitle,
}: CandlestickChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const isChartReadyRef = useRef(false);

  // Memoize chart data transformation
  const chartData = useMemo(() => {
    if (!data) return [];
    return transformToChartData(data);
  }, [data]);

  // Initialize chart
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    logger.debug("CandlestickChart", "Creating chart, container width:", container.clientWidth);

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#888",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#2B2B3D" },
        horzLines: { color: "#2B2B3D" },
      },
      width: container.clientWidth || CHART_CONFIG.DEFAULT_WIDTH,
      height: CHART_CONFIG.HEIGHT,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "#2B2B3D",
      },
      rightPriceScale: {
        borderColor: "#2B2B3D",
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: "#555",
          labelBackgroundColor: "#363A45",
        },
        horzLine: {
          color: "#555",
          labelBackgroundColor: "#363A45",
        },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    isChartReadyRef.current = true;

    // Handle resize with debouncing
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (container && chartRef.current) {
          chartRef.current.applyOptions({
            width: container.clientWidth,
          });
        }
      }, CHART_CONFIG.RESIZE_DEBOUNCE_MS);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      logger.debug("CandlestickChart", "Cleanup - removing chart");
      clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handleResize);
      isChartReadyRef.current = false;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update data when available
  useEffect(() => {
    if (!isChartReadyRef.current || !seriesRef.current || chartData.length === 0) {
      return;
    }

    logger.debug("CandlestickChart", "Setting", chartData.length, "candles");
    seriesRef.current.setData(chartData as CandlestickData<Time>[]);

    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [chartData]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[400px] items-center justify-center text-red-500">
            Failed to load chart data: {error.message}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            {subtitle && (
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1 truncate max-w-[600px]">
                {subtitle}
              </p>
            )}
          </div>
          {loading && (
            <span className="text-sm text-[hsl(var(--muted-foreground))]">
              Updating...
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="relative">
        <div ref={chartContainerRef} className="w-full h-[400px]" />
        {loading && !data && (
          <div className="absolute inset-0">
            <Skeleton className="h-full w-full" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
