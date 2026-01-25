import { useQuery } from "@tanstack/react-query";
import { fetchOHLC } from "@/lib/api";

interface UseOHLCOptions {
  interval?: string;
  hours?: number;
  enabled?: boolean;
}

/**
 * Hook to fetch OHLC data for a specific asset
 * Auto-refreshes every 60 seconds
 */
export function useOHLC(assetId: string | null, options: UseOHLCOptions = {}) {
  const { interval = "1m", hours = 24, enabled = true } = options;

  return useQuery({
    queryKey: ["ohlc", assetId, interval, hours],
    queryFn: () => fetchOHLC(assetId!, interval, hours),
    enabled: enabled && !!assetId,
    refetchInterval: 60 * 1000, // Refresh every minute
    staleTime: 30 * 1000, // Consider stale after 30 seconds
  });
}
