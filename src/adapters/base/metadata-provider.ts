// src/adapters/base/metadata-provider.ts
// Metadata provider interface for fetching and caching market instrument data

import type { MarketSource } from "../../core/enums";
import type { InstrumentID } from "../../core/instrument";
import type { MarketMetadata, MarketLifecycleEvent } from "../../core/market-data";

/**
 * Cache entry for metadata
 */
export interface MetadataCacheEntry {
  metadata: MarketMetadata;
  cachedAt: number;
  ttlMs: number;
}

/**
 * Metadata fetch options
 */
export interface MetadataFetchOptions {
  /** Force refresh from API, bypassing cache */
  forceRefresh?: boolean;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Metadata provider interface
 * Handles market/instrument metadata fetching and caching
 *
 * Each market implements this to normalize their metadata API
 * (e.g., Polymarket Gamma API, Kalshi REST API)
 */
export interface IMetadataProvider {
  /** Market this provider is for */
  readonly marketSource: MarketSource;

  /**
   * Initialize the provider (setup KV cache, etc.)
   *
   * @param kvNamespace - KV namespace for caching
   */
  initialize(kvNamespace: KVNamespace): Promise<void>;

  /**
   * Fetch metadata for instruments from the market's API
   * Results are normalized to canonical MarketMetadata format
   *
   * @param nativeIds - Native market IDs to fetch
   * @param options - Fetch options
   * @returns Map of native ID -> metadata
   */
  fetchMetadata(
    nativeIds: string[],
    options?: MetadataFetchOptions
  ): Promise<Map<string, MarketMetadata>>;

  /**
   * Fetch metadata for a single instrument
   *
   * @param nativeId - Native market ID
   * @param options - Fetch options
   * @returns Metadata or null if not found
   */
  fetchSingleMetadata(
    nativeId: string,
    options?: MetadataFetchOptions
  ): Promise<MarketMetadata | null>;

  /**
   * Get cached metadata (from KV)
   *
   * @param nativeId - Native market ID
   * @returns Metadata or null if not in cache
   */
  getCachedMetadata(nativeId: string): Promise<MarketMetadata | null>;

  /**
   * Update cache with fresh metadata
   *
   * @param metadata - Map of native ID -> metadata
   * @param ttlMs - TTL for cache entries (default: 1 hour)
   */
  updateCache(
    metadata: Map<string, MarketMetadata>,
    ttlMs?: number
  ): Promise<void>;

  /**
   * Poll for lifecycle events (new markets, resolutions, etc.)
   * Returns events that occurred since last check
   *
   * @param sinceTimestamp - Only return events after this timestamp
   */
  pollLifecycleEvents(sinceTimestamp?: number): Promise<MarketLifecycleEvent[]>;

  /**
   * Look up the canonical instrument ID for a native ID
   *
   * @param nativeId - Native market ID
   * @returns Canonical InstrumentID or null
   */
  getInstrumentId(nativeId: string): Promise<InstrumentID | null>;

  /**
   * Look up the market ID (condition_id, series_ticker, etc.) for a native ID
   *
   * @param nativeId - Native market ID (token_id, ticker)
   * @returns Market ID or null
   */
  getMarketId(nativeId: string): Promise<string | null>;

  /**
   * Get all related instruments for a market
   * E.g., for Polymarket binary markets, returns both YES and NO token IDs
   *
   * @param marketId - Market ID (condition_id, series_ticker, pool_address)
   * @returns Array of native IDs
   */
  getRelatedInstruments(marketId: string): Promise<string[]>;

  /**
   * Invalidate cache for specific instruments
   *
   * @param nativeIds - Native IDs to invalidate
   */
  invalidateCache(nativeIds: string[]): Promise<void>;
}

/**
 * Base class for metadata providers with common caching logic
 */
export abstract class BaseMetadataProvider implements IMetadataProvider {
  abstract readonly marketSource: MarketSource;

  protected kvNamespace!: KVNamespace;
  protected initialized = false;

  // Cache key prefix for this market
  protected get cacheKeyPrefix(): string {
    return `metadata:${this.marketSource}:`;
  }

  async initialize(kvNamespace: KVNamespace): Promise<void> {
    this.kvNamespace = kvNamespace;
    this.initialized = true;
  }

  abstract fetchMetadata(
    nativeIds: string[],
    options?: MetadataFetchOptions
  ): Promise<Map<string, MarketMetadata>>;

  async fetchSingleMetadata(
    nativeId: string,
    options?: MetadataFetchOptions
  ): Promise<MarketMetadata | null> {
    const results = await this.fetchMetadata([nativeId], options);
    return results.get(nativeId) ?? null;
  }

  async getCachedMetadata(nativeId: string): Promise<MarketMetadata | null> {
    if (!this.initialized) return null;

    const key = `${this.cacheKeyPrefix}${nativeId}`;
    const cached = await this.kvNamespace.get(key, "json");

    if (!cached) return null;

    const entry = cached as MetadataCacheEntry;

    // Check if expired
    if (Date.now() > entry.cachedAt + entry.ttlMs) {
      return null;
    }

    return entry.metadata;
  }

  async updateCache(
    metadata: Map<string, MarketMetadata>,
    ttlMs: number = 3600000 // 1 hour default
  ): Promise<void> {
    if (!this.initialized) return;

    const now = Date.now();
    const promises: Promise<void>[] = [];

    for (const [nativeId, meta] of metadata) {
      const key = `${this.cacheKeyPrefix}${nativeId}`;
      const entry: MetadataCacheEntry = {
        metadata: meta,
        cachedAt: now,
        ttlMs,
      };

      promises.push(
        this.kvNamespace.put(key, JSON.stringify(entry), {
          expirationTtl: Math.ceil(ttlMs / 1000),
        })
      );
    }

    await Promise.all(promises);
  }

  abstract pollLifecycleEvents(sinceTimestamp?: number): Promise<MarketLifecycleEvent[]>;
  abstract getInstrumentId(nativeId: string): Promise<InstrumentID | null>;
  abstract getMarketId(nativeId: string): Promise<string | null>;
  abstract getRelatedInstruments(marketId: string): Promise<string[]>;

  async invalidateCache(nativeIds: string[]): Promise<void> {
    if (!this.initialized) return;

    const promises = nativeIds.map((nativeId) => {
      const key = `${this.cacheKeyPrefix}${nativeId}`;
      return this.kvNamespace.delete(key);
    });

    await Promise.all(promises);
  }
}
