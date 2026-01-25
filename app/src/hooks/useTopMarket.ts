import { useQuery } from "@tanstack/react-query";
import { fetchTopActivity } from "@/lib/api";

/**
 * Hook to fetch the most active market by tick count
 * Refreshes every 10 minutes
 */
export function useTopMarket() {
  return useQuery({
    queryKey: ["top-market"],
    queryFn: fetchTopActivity,
    refetchInterval: 10 * 60 * 1000, // Refresh every 10 minutes
    staleTime: 9 * 60 * 1000, // Consider stale after 9 minutes
  });
}
