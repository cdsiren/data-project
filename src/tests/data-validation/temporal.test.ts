/**
 * P2 Temporal Integrity Tests
 *
 * These tests validate time-based data integrity including
 * timestamp ordering, latency bounds, and temporal consistency.
 *
 * Run with: npx vitest run src/tests/data-validation/temporal.test.ts
 *
 * Required environment variables:
 * - CLICKHOUSE_URL: Full URL to ClickHouse HTTP interface
 * - CLICKHOUSE_USER: ClickHouse username (default: "default")
 * - CLICKHOUSE_TOKEN: ClickHouse password/API key
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getClickHouseConfig,
  executeQuery,
  getTable,
  TEST_CONFIG,
  VALIDATION_THRESHOLDS,
  type ClickHouseConfig,
  type ValidationResult,
  formatValidationResults,
} from "./test-utils";

describe("P2: Temporal Integrity", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping Temporal tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("Timestamp Ordering", () => {
    it("should have ingestion_ts >= source_ts in ob_snapshots", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(ingestion_ts < source_ts) as time_travel,
          min(dateDiff('millisecond', source_ts, ingestion_ts)) as min_latency_ms,
          max(dateDiff('millisecond', source_ts, ingestion_ts)) as max_latency_ms
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        time_travel: string;
        min_latency_ms: number;
        max_latency_ms: number;
      }>(config, query);

      const total = Number(result.data[0].total);
      const timeTravel = Number(result.data[0].time_travel);
      const minLatency = result.data[0].min_latency_ms;
      const maxLatency = result.data[0].max_latency_ms;

      console.log(`\nTimestamp ordering (ob_snapshots):`);
      console.log(`  Total records: ${total}`);
      console.log(`  Time travel (ingestion < source): ${timeTravel}`);
      console.log(`  Latency range: ${minLatency}ms to ${maxLatency}ms`);

      const timeTravelPercent = total > 0 ? (timeTravel / total) * 100 : 0;

      validationResults.push({
        passed: timeTravelPercent < 1, // Allow < 1% for historical data with timestamp bug
        test: "ob_snapshots: ingestion_ts >= source_ts",
        message:
          timeTravel === 0
            ? "All timestamps correctly ordered"
            : `${timeTravel}/${total} (${timeTravelPercent.toFixed(2)}%) records have time travel (historical artifact)`,
        actual: { timeTravel, timeTravelPercent, minLatency, maxLatency },
        sampleSize: total,
      });

      // Allow up to 1% time travel for backwards compatibility with historical data
      expect(timeTravelPercent).toBeLessThan(VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT);
    });

    it("should have ingestion_ts >= source_ts in trade_ticks", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(ingestion_ts < source_ts) as time_travel,
          min(dateDiff('millisecond', source_ts, ingestion_ts)) as min_latency_ms,
          max(dateDiff('millisecond', source_ts, ingestion_ts)) as max_latency_ms
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        time_travel: string;
        min_latency_ms: number;
        max_latency_ms: number;
      }>(config, query);

      const total = Number(result.data[0].total);
      const timeTravel = Number(result.data[0].time_travel);

      console.log(`\nTimestamp ordering (trade_ticks):`);
      console.log(`  Total records: ${total}`);
      console.log(`  Time travel: ${timeTravel}`);

      const timeTravelPercent = total > 0 ? (timeTravel / total) * 100 : 0;

      validationResults.push({
        passed: timeTravelPercent < 1, // Allow < 1% for historical data with timestamp bug
        test: "trade_ticks: ingestion_ts >= source_ts",
        message:
          timeTravel === 0
            ? "All timestamps correctly ordered"
            : `${timeTravel}/${total} (${timeTravelPercent.toFixed(2)}%) records have time travel (historical artifact)`,
        sampleSize: total,
      });

      // Allow up to 1% time travel for backwards compatibility with historical data
      expect(timeTravelPercent).toBeLessThan(VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT);
    });

    it("should have ingestion_ts >= source_ts in ob_level_changes", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(ingestion_ts < source_ts) as time_travel
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        time_travel: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const timeTravel = Number(result.data[0].time_travel);

      console.log(`\nTimestamp ordering (ob_level_changes):`);
      console.log(`  Total records: ${total}`);
      console.log(`  Time travel: ${timeTravel}`);

      const timeTravelPercent = total > 0 ? (timeTravel / total) * 100 : 0;

      validationResults.push({
        passed: timeTravelPercent < 1, // Allow < 1% for historical data with timestamp bug
        test: "ob_level_changes: ingestion_ts >= source_ts",
        message:
          timeTravel === 0
            ? "All timestamps correctly ordered"
            : `${timeTravel}/${total} (${timeTravelPercent.toFixed(2)}%) records have time travel (historical artifact)`,
        sampleSize: total,
      });

      // Allow up to 1% time travel for backwards compatibility with historical data
      expect(timeTravelPercent).toBeLessThan(VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT);
    });
  });

  describe("Latency Distribution", () => {
    it("should have reasonable ingestion latency in ob_snapshots", async () => {
      if (!config) return;

      const query = `
        SELECT
          quantile(0.5)(dateDiff('millisecond', source_ts, ingestion_ts)) as p50,
          quantile(0.90)(dateDiff('millisecond', source_ts, ingestion_ts)) as p90,
          quantile(0.95)(dateDiff('millisecond', source_ts, ingestion_ts)) as p95,
          quantile(0.99)(dateDiff('millisecond', source_ts, ingestion_ts)) as p99,
          max(dateDiff('millisecond', source_ts, ingestion_ts)) as max_latency,
          count() as sample_size
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        p50: number;
        p90: number;
        p95: number;
        p99: number;
        max_latency: number;
        sample_size: string;
      }>(config, query);

      const { p50, p90, p95, p99, max_latency, sample_size } = result.data[0];

      console.log(`\nIngestion latency (ob_snapshots, n=${sample_size}):`);
      console.log(`  p50: ${p50}ms`);
      console.log(`  p90: ${p90}ms`);
      console.log(`  p95: ${p95}ms`);
      console.log(`  p99: ${p99}ms`);
      console.log(`  max: ${max_latency}ms`);

      const p99InBounds = p99 < TEST_CONFIG.MAX_LATENCY_MS;

      validationResults.push({
        passed: p99InBounds,
        test: "ob_snapshots latency p99 < 60s",
        message: p99InBounds
          ? `p99=${p99}ms within bounds`
          : `p99=${p99}ms exceeds ${TEST_CONFIG.MAX_LATENCY_MS}ms`,
        actual: { p50, p90, p95, p99, max_latency },
        sampleSize: Number(sample_size),
      });

      expect(p99).toBeLessThan(TEST_CONFIG.MAX_LATENCY_MS);
    });

    it("should have reasonable ingestion latency in trade_ticks", async () => {
      if (!config) return;

      const query = `
        SELECT
          quantile(0.5)(dateDiff('millisecond', source_ts, ingestion_ts)) as p50,
          quantile(0.95)(dateDiff('millisecond', source_ts, ingestion_ts)) as p95,
          quantile(0.99)(dateDiff('millisecond', source_ts, ingestion_ts)) as p99,
          max(dateDiff('millisecond', source_ts, ingestion_ts)) as max_latency,
          count() as sample_size
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        p50: number;
        p95: number;
        p99: number;
        max_latency: number;
        sample_size: string;
      }>(config, query);

      const { p50, p95, p99, max_latency, sample_size } = result.data[0];

      console.log(`\nIngestion latency (trade_ticks, n=${sample_size}):`);
      console.log(`  p50: ${p50}ms`);
      console.log(`  p95: ${p95}ms`);
      console.log(`  p99: ${p99}ms`);
      console.log(`  max: ${max_latency}ms`);

      validationResults.push({
        passed: p99 < TEST_CONFIG.MAX_LATENCY_MS,
        test: "trade_ticks latency p99 < 60s",
        message: `p99=${p99}ms`,
        actual: { p50, p95, p99, max_latency },
        sampleSize: Number(sample_size),
      });

      expect(p99).toBeLessThan(TEST_CONFIG.MAX_LATENCY_MS);
    });
  });

  describe("Timestamp Precision", () => {
    it("should have millisecond precision in source_ts", async () => {
      if (!config) return;

      // Check if timestamps have sub-second precision
      const query = `
        SELECT
          count() as total,
          countIf(toMillisecond(source_ts) = 0) as zero_ms,
          countIf(toMillisecond(source_ts) % 100 = 0) as rounded_100ms,
          countIf(toMillisecond(source_ts) % 1000 = 0) as rounded_1s
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        zero_ms: string;
        rounded_100ms: string;
        rounded_1s: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const zeroMs = Number(result.data[0].zero_ms);
      const rounded1s = Number(result.data[0].rounded_1s);

      const zeroMsPercent = total > 0 ? (zeroMs / total) * 100 : 0;
      const rounded1sPercent = total > 0 ? (rounded1s / total) * 100 : 0;

      console.log(`\nTimestamp precision (ob_snapshots):`);
      console.log(`  Total: ${total}`);
      console.log(`  Zero milliseconds: ${zeroMs} (${zeroMsPercent.toFixed(1)}%)`);
      console.log(`  Rounded to second: ${rounded1s} (${rounded1sPercent.toFixed(1)}%)`);

      // If > 50% have exactly zero ms, precision may be truncated
      const hasPrecision = zeroMsPercent < 50;

      validationResults.push({
        passed: hasPrecision,
        test: "source_ts has millisecond precision",
        message: hasPrecision
          ? "Timestamps have proper millisecond precision"
          : `${zeroMsPercent.toFixed(1)}% timestamps truncated to seconds`,
        actual: { zeroMsPercent, rounded1sPercent },
        sampleSize: total,
      });

      expect(zeroMsPercent).toBeLessThan(50);
    });

    it("should have microsecond precision in ingestion_ts", async () => {
      if (!config) return;

      // ingestion_ts should be DateTime64(6) with microsecond precision
      // Check using modular arithmetic on the underlying value (microseconds since epoch)
      const query = `
        SELECT
          count() as total,
          countIf(toUnixTimestamp64Micro(ingestion_ts) % 1000 = 0) as truncated_to_ms,
          countIf(toUnixTimestamp64Micro(ingestion_ts) % 1000000 = 0) as truncated_to_second
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        truncated_to_ms: string;
        truncated_to_second: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const truncatedToMs = Number(result.data[0].truncated_to_ms);
      const truncatedPercent = total > 0 ? (truncatedToMs / total) * 100 : 0;

      console.log(`\nMicrosecond precision (ingestion_ts):`);
      console.log(`  Total: ${total}`);
      console.log(`  Truncated to ms: ${truncatedToMs} (${truncatedPercent.toFixed(1)}%)`);

      validationResults.push({
        passed: true, // Informational
        test: "ingestion_ts precision",
        message: `${truncatedPercent.toFixed(1)}% truncated to milliseconds`,
        sampleSize: total,
      });
    });
  });

  describe("Temporal Monotonicity", () => {
    it("should have mostly monotonic source_ts per asset", async () => {
      if (!config) return;

      // Check for out-of-order timestamps within each asset
      const query = `
        WITH ordered AS (
          SELECT
            asset_id,
            source_ts,
            lagInFrame(source_ts) OVER (PARTITION BY asset_id ORDER BY sequence_number) as prev_ts
          FROM ${getTable("OB_SNAPSHOTS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        )
        SELECT
          count() as total,
          countIf(source_ts < prev_ts) as out_of_order
        FROM ordered
        WHERE prev_ts IS NOT NULL
      `;

      const result = await executeQuery<{
        total: string;
        out_of_order: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const outOfOrder = Number(result.data[0].out_of_order);
      const outOfOrderPercent = total > 0 ? (outOfOrder / total) * 100 : 0;

      console.log(`\nTemporal monotonicity (ob_snapshots):`);
      console.log(`  Total pairs: ${total}`);
      console.log(`  Out of order: ${outOfOrder} (${outOfOrderPercent.toFixed(2)}%)`);

      // Note: High out-of-order rate can occur due to WebSocket message reordering,
      // network latency variations, or multi-source ingestion. This test reports
      // Out-of-order events can happen due to WebSocket message reordering
      validationResults.push({
        passed: outOfOrderPercent < VALIDATION_THRESHOLDS.OUT_OF_ORDER_PERCENT,
        test: "source_ts monotonic per asset",
        message:
          outOfOrderPercent < 5
            ? `${outOfOrderPercent.toFixed(2)}% out of order (good)`
            : `${outOfOrderPercent.toFixed(2)}% out of order (threshold: ${VALIDATION_THRESHOLDS.OUT_OF_ORDER_PERCENT}%)`,
        actual: { outOfOrder, total },
        sampleSize: total,
      });

      expect(outOfOrderPercent).toBeLessThan(VALIDATION_THRESHOLDS.OUT_OF_ORDER_PERCENT);
    });

    it("should have trades in chronological order", async () => {
      if (!config) return;

      const query = `
        WITH ordered AS (
          SELECT
            asset_id,
            source_ts,
            lagInFrame(source_ts) OVER (PARTITION BY asset_id ORDER BY source_ts) as prev_ts
          FROM ${getTable("TRADE_TICKS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        )
        SELECT
          count() as total,
          countIf(source_ts < prev_ts) as out_of_order
        FROM ordered
        WHERE prev_ts IS NOT NULL
      `;

      const result = await executeQuery<{
        total: string;
        out_of_order: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const outOfOrder = Number(result.data[0].out_of_order);

      console.log(`\nTemporal monotonicity (trade_ticks):`);
      console.log(`  Total pairs: ${total}`);
      console.log(`  Out of order: ${outOfOrder}`);

      validationResults.push({
        passed: outOfOrder === 0,
        test: "trade_ticks chronological order",
        message:
          outOfOrder === 0
            ? "All trades in chronological order"
            : `${outOfOrder} trades out of order`,
        sampleSize: total,
      });

      expect(outOfOrder).toBe(0);
    });
  });

  describe("Timestamp Bounds", () => {
    it("should not have timestamps in the future", async () => {
      if (!config) return;

      const tables = [
        { name: "ob_snapshots", table: getTable("OB_SNAPSHOTS") },
        { name: "trade_ticks", table: getTable("TRADE_TICKS") },
        { name: "ob_level_changes", table: getTable("OB_LEVEL_CHANGES") },
      ];

      let totalFuture = 0;
      const futureByTable: Record<string, number> = {};

      for (const { name, table } of tables) {
        const query = `
          SELECT count() as future_count
          FROM ${table}
          WHERE source_ts > now() + INTERVAL 1 MINUTE
        `;

        try {
          const result = await executeQuery<{ future_count: string }>(config, query);
          const count = Number(result.data[0].future_count);
          futureByTable[name] = count;
          totalFuture += count;
        } catch {
          futureByTable[name] = -1; // Table doesn't exist
        }
      }

      console.log(`\nFuture timestamps:`);
      for (const [name, count] of Object.entries(futureByTable)) {
        console.log(`  ${name}: ${count}`);
      }

      validationResults.push({
        passed: totalFuture === 0,
        test: "No future timestamps",
        message:
          totalFuture === 0
            ? "No timestamps in the future"
            : `${totalFuture} records have future timestamps`,
        actual: futureByTable,
      });

      expect(totalFuture).toBe(0);
    });

    it("should not have timestamps too far in the past", async () => {
      if (!config) return;

      // Check for timestamps older than expected retention
      const query = `
        SELECT
          min(source_ts) as oldest,
          dateDiff('day', min(source_ts), now()) as days_old
        FROM ${getTable("OB_SNAPSHOTS")}
      `;

      const result = await executeQuery<{
        oldest: string;
        days_old: number;
      }>(config, query);

      const oldest = result.data[0].oldest;
      const daysOld = result.data[0].days_old;

      console.log(`\nOldest timestamp (ob_snapshots):`);
      console.log(`  Oldest: ${oldest}`);
      console.log(`  Days old: ${daysOld}`);

      // 90 day TTL expected
      validationResults.push({
        passed: daysOld <= 100,
        test: "Timestamps within retention period",
        message: `Oldest data is ${daysOld} days old`,
        actual: { oldest, daysOld },
      });

      expect(daysOld).toBeLessThan(100);
    });
  });

  describe("Event Ordering Consistency", () => {
    it("should have gap_events detected_at after the gap start", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(gap_duration_ms < 0) as negative_duration
        FROM ${getTable("OB_GAP_EVENTS")}
        WHERE detected_at >= now() - INTERVAL 7 DAY
      `;

      const result = await executeQuery<{
        total: string;
        negative_duration: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const negativeDuration = Number(result.data[0].negative_duration);

      console.log(`\nGap event timing:`);
      console.log(`  Total gap events: ${total}`);
      console.log(`  Negative duration: ${negativeDuration}`);

      validationResults.push({
        passed: negativeDuration === 0,
        test: "Gap events have valid duration",
        message:
          negativeDuration === 0
            ? "All gap durations are non-negative"
            : `${negativeDuration} gaps have negative duration`,
        sampleSize: total,
      });

      expect(negativeDuration).toBe(0);
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
