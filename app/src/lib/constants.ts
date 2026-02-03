// Application constants

/**
 * System-wide configuration that MUST match backend settings.
 * CRITICAL: If you change SHARD_COUNT, you MUST also update:
 *   - Backend: src/index.ts (SHARD_COUNT constant)
 *   - Wrangler config: wrangler.toml (durable object bindings)
 * Mismatched shard counts cause incorrect shard assignments and data loss.
 */
export const SYSTEM_CONFIG = {
  SHARD_COUNT: 25,
} as const;

export const SSE_CONFIG = {
  MAX_EVENTS: 20,
  RECONNECT_BASE_DELAY_MS: 3000,
  RECONNECT_BACKOFF_FACTOR: 1.5,
  MAX_RECONNECT_ATTEMPTS: 10,
} as const;

export const QUERY_CONFIG = {
  TOP_MARKET_REFRESH_MS: 10 * 60 * 1000,
  TOP_MARKET_STALE_MS: 9 * 60 * 1000,
  OHLC_REFRESH_MS: 60 * 1000,
  OHLC_STALE_MS: 30 * 1000,
  DEFAULT_STALE_MS: 30 * 1000,
} as const;

export const CHART_CONFIG = {
  HEIGHT: 400,
  DEFAULT_WIDTH: 800,
  RESIZE_DEBOUNCE_MS: 150,
} as const;

export const METRICS_CONFIG = {
  POLL_INTERVAL_MS: 30000,
  STALE_MS: 25000,
} as const;
