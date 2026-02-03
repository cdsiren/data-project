// src/utils/ring-buffer.ts
// Ring buffer for latency percentile tracking

/**
 * Fixed-size circular buffer that overwrites oldest entries when full.
 * Memory-efficient for sliding window calculations.
 */
export class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  getAll(): T[] {
    if (this.size === 0) return [];
    if (this.size < this.capacity) return this.buffer.slice(0, this.size);
    // For percentile calculation, order doesn't matter - single slice is faster
    return this.buffer.slice();
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

/**
 * Latency statistics with percentiles
 */
export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  count: number;
  window_ms: number;
}

/**
 * Tracks dual latency metrics (total vs processing) with percentile calculations.
 * Uses ring buffers for memory-efficient sliding window tracking.
 *
 * - total_latency_us: Time from Polymarket source_ts to trigger fired_at (includes network)
 * - processing_latency_us: Time from DO ingestion_ts to trigger fired_at (DO code only)
 */
export class LatencyTracker {
  private totalBuffer: RingBuffer<number>;
  private processingBuffer: RingBuffer<number>;
  private windowStart = Date.now();

  constructor(bufferSize = 1000) {
    this.totalBuffer = new RingBuffer(bufferSize);
    this.processingBuffer = new RingBuffer(bufferSize);
  }

  /**
   * Record a latency measurement for both total and processing latency.
   * @param totalUs Total latency in microseconds (source_ts to fired_at)
   * @param processingUs Processing latency in microseconds (ingestion_ts to fired_at)
   */
  record(totalUs: number, processingUs: number): void {
    this.totalBuffer.push(totalUs);
    this.processingBuffer.push(processingUs);
  }

  /**
   * Get latency statistics for both total and processing latency.
   */
  getStats(): { total: LatencyStats; processing: LatencyStats } {
    return {
      total: this.computeStats(this.totalBuffer.getAll()),
      processing: this.computeStats(this.processingBuffer.getAll()),
    };
  }

  /**
   * Reset the tracker and start a new measurement window.
   */
  reset(): void {
    this.totalBuffer.clear();
    this.processingBuffer.clear();
    this.windowStart = Date.now();
  }

  private computeStats(values: number[]): LatencyStats {
    const n = values.length;
    if (n === 0) {
      return {
        p50: 0,
        p95: 0,
        p99: 0,
        mean: 0,
        min: 0,
        max: 0,
        count: 0,
        window_ms: Date.now() - this.windowStart,
      };
    }

    // Compute min, max, sum in single pass - O(n)
    let sum = 0;
    let min = values[0];
    let max = values[0];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // Sort once O(n log n) and extract all percentiles
    // For n=1000, V8's Timsort is ~0.1ms - simpler than 3x quickselect with cloning
    const sorted = values.slice().sort((a, b) => a - b);
    const getPercentileIndex = (percentile: number): number =>
      Math.min(Math.floor(n * percentile), n - 1);

    return {
      p50: sorted[getPercentileIndex(0.5)],
      p95: sorted[getPercentileIndex(0.95)],
      p99: sorted[getPercentileIndex(0.99)],
      mean: Math.round(sum / n),
      min,
      max,
      count: n,
      window_ms: Date.now() - this.windowStart,
    };
  }
}
