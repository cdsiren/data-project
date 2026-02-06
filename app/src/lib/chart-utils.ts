/**
 * Format price for prediction markets (0-1 range, show as cents)
 */
export function formatPrice(price: number | null): string {
  if (price === null) return "-";
  return `${(price * 100).toFixed(1)}¢`;
}

/**
 * Format spread in basis points
 */
export function formatSpread(bps: number | null): string {
  if (bps === null) return "-";
  return `${bps.toFixed(0)} bps`;
}

/**
 * Format timestamp to readable time
 */
export function formatTime(timestamp: number): string {
  const ms = timestamp > 1e12 ? timestamp / 1000 : timestamp;
  return new Date(ms).toLocaleTimeString();
}

/**
 * Format latency in microseconds to readable format with validation
 */
export function formatLatency(latencyUs: number | null | undefined): string {
  if (latencyUs == null || isNaN(latencyUs)) return "-";
  if (latencyUs < 0) return "-"; // Invalid (clock skew or calculation error)
  if (latencyUs < 1000) return `${latencyUs.toFixed(0)}μs`;
  return `${(latencyUs / 1000).toFixed(1)}ms`;
}
