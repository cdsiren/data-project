// app/src/lib/format-utils.ts
// Shared formatting utilities for metrics display

/**
 * Format milliseconds for display with appropriate units
 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms)) return "-";
  if (ms < 0) return "-"; // Invalid
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(0)}ms`;
}

/**
 * Format large numbers with K/M suffix
 */
export function formatCount(n: number | undefined): string {
  if (n == null) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}
