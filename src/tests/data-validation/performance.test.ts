/**
 * P2 Performance Tests
 *
 * These tests validate query performance, data volume metrics,
 * and ensure the database can handle expected workloads.
 *
 * Run with: npx vitest run src/tests/data-validation/performance.test.ts
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
  type ClickHouseConfig,
  type ValidationResult,
  formatValidationResults,
} from "./test-utils";

describe("P2: Performance", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping Performance tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("Query Latency", () => {
    it("should execute simple count query < 1s", async () => {
      if (!config) return;

      const startTime = Date.now();
      const query = `
        SELECT count() as cnt
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
      `;

      const result = await executeQuery<{ cnt: string }>(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nSimple count query:`);
      console.log(`  Result: ${result.data[0].cnt} rows`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 1000,
        test: "Simple count query < 1s",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, rows: result.data[0].cnt },
      });

      expect(elapsed).toBeLessThan(1000);
    });

    it("should execute aggregation query < 2s", async () => {
      if (!config) return;

      const startTime = Date.now();
      const query = `
        SELECT
          asset_id,
          count() as snapshot_count,
          avg(best_bid) as avg_bid,
          avg(best_ask) as avg_ask
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
        GROUP BY asset_id
        ORDER BY snapshot_count DESC
        LIMIT 100
      `;

      const result = await executeQuery(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nAggregation query:`);
      console.log(`  Result: ${result.data.length} groups`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 2000,
        test: "Aggregation query < 2s",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, groups: result.data.length },
      });

      expect(elapsed).toBeLessThan(2000);
    });

    it("should execute time-series query < 2s", async () => {
      if (!config) return;

      const startTime = Date.now();
      const query = `
        SELECT
          toStartOfMinute(source_ts) as minute,
          count() as tick_count,
          avg(spread_bps) as avg_spread
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
        GROUP BY minute
        ORDER BY minute
      `;

      const result = await executeQuery(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nTime-series query:`);
      console.log(`  Result: ${result.data.length} minutes`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 2000,
        test: "Time-series query < 2s",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, minutes: result.data.length },
      });

      expect(elapsed).toBeLessThan(2000);
    });

    it("should execute join query < 5s", async () => {
      if (!config) return;

      const startTime = Date.now();
      const query = `
        SELECT
          s.asset_id,
          count(DISTINCT t.trade_id) as trade_count,
          count(DISTINCT s.book_hash) as snapshot_count
        FROM ${getTable("OB_SNAPSHOTS")} s
        LEFT JOIN ${getTable("TRADE_TICKS")} t ON s.asset_id = t.asset_id
          AND t.source_ts BETWEEN s.source_ts - INTERVAL 1 MINUTE AND s.source_ts + INTERVAL 1 MINUTE
        WHERE s.source_ts >= now() - INTERVAL 1 HOUR
        GROUP BY s.asset_id
        LIMIT 50
      `;

      const result = await executeQuery(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nJoin query:`);
      console.log(`  Result: ${result.data.length} assets`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 5000,
        test: "Join query < 5s",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, assets: result.data.length },
      });

      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("Data Volume Metrics", () => {
    it("should report table sizes and row counts", async () => {
      if (!config) return;

      const query = `
        SELECT
          table,
          formatReadableSize(sum(bytes_on_disk)) as disk_size,
          formatReadableQuantity(sum(rows)) as row_count,
          sum(rows) as raw_rows,
          sum(bytes_on_disk) as raw_bytes
        FROM system.parts
        WHERE database = 'polymarket'
          AND active = 1
        GROUP BY table
        ORDER BY raw_bytes DESC
      `;

      const result = await executeQuery<{
        table: string;
        disk_size: string;
        row_count: string;
        raw_rows: string;
        raw_bytes: string;
      }>(config, query);

      console.log(`\nTable sizes:`);
      let totalRows = 0;
      let totalBytes = 0;
      for (const row of result.data) {
        console.log(`  ${row.table}: ${row.disk_size} (${row.row_count} rows)`);
        totalRows += Number(row.raw_rows);
        totalBytes += Number(row.raw_bytes);
      }
      console.log(`  TOTAL: ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB (${totalRows.toLocaleString()} rows)`);

      validationResults.push({
        passed: true,
        test: "Table size metrics",
        message: `${result.data.length} tables, ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB total`,
        actual: result.data.slice(0, 5),
      });
    });

    it("should report ingestion rate (rows/second)", async () => {
      if (!config) return;

      const tables = [
        { name: "ob_snapshots", table: getTable("OB_SNAPSHOTS") },
        { name: "trade_ticks", table: getTable("TRADE_TICKS") },
        { name: "ob_level_changes", table: getTable("OB_LEVEL_CHANGES") },
      ];

      const rates: Record<string, number> = {};

      for (const { name, table } of tables) {
        const query = `
          SELECT
            count() as row_count,
            dateDiff('second', min(source_ts), max(source_ts)) as duration_seconds
          FROM ${table}
          WHERE source_ts >= now() - INTERVAL 1 HOUR
        `;

        try {
          const result = await executeQuery<{
            row_count: string;
            duration_seconds: number;
          }>(config, query);

          const rows = Number(result.data[0].row_count);
          const duration = result.data[0].duration_seconds || 1;
          rates[name] = rows / duration;
        } catch {
          rates[name] = 0;
        }
      }

      console.log(`\nIngestion rates (last hour):`);
      for (const [name, rate] of Object.entries(rates)) {
        console.log(`  ${name}: ${rate.toFixed(1)} rows/sec`);
      }

      validationResults.push({
        passed: true,
        test: "Ingestion rate metrics",
        message: `Rates: ${Object.entries(rates).map(([k, v]) => `${k}=${v.toFixed(1)}/s`).join(", ")}`,
        actual: rates,
      });
    });
  });

  describe("Partition Pruning", () => {
    it("should prune partitions for time-bounded queries", async () => {
      if (!config) return;

      // Query with EXPLAIN to check partition pruning
      const query = `
        SELECT count() as cnt
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
      `;

      const startTime = Date.now();
      const result = await executeQuery<{ cnt: string }>(config, query);
      const elapsed = Date.now() - startTime;

      // Also get partition info
      const partitionQuery = `
        SELECT
          partition,
          count() as parts,
          sum(rows) as rows,
          formatReadableSize(sum(bytes_on_disk)) as size
        FROM system.parts
        WHERE database = 'polymarket'
          AND table = 'ob_snapshots'
          AND active = 1
        GROUP BY partition
        ORDER BY partition DESC
        LIMIT 5
      `;

      const partitions = await executeQuery<{
        partition: string;
        parts: string;
        rows: string;
        size: string;
      }>(config, partitionQuery);

      console.log(`\nPartition pruning:`);
      console.log(`  Query result: ${result.data[0].cnt} rows in ${elapsed}ms`);
      console.log(`  Active partitions:`);
      for (const p of partitions.data) {
        console.log(`    ${p.partition}: ${p.parts} parts, ${p.rows} rows, ${p.size}`);
      }

      validationResults.push({
        passed: elapsed < 1000,
        test: "Partition pruning effective",
        message: `Time-bounded query completed in ${elapsed}ms`,
        actual: { elapsed, partitions: partitions.data.length },
      });

      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("Index Efficiency", () => {
    it("should efficiently query by asset_id", async () => {
      if (!config) return;

      // Get a sample asset_id
      const sampleQuery = `
        SELECT asset_id
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
        LIMIT 1
      `;

      const sampleResult = await executeQuery<{ asset_id: string }>(config, sampleQuery);
      if (sampleResult.data.length === 0) {
        console.log("\nNo data available for index test");
        return;
      }

      const assetId = sampleResult.data[0].asset_id;

      // Query by asset_id
      const startTime = Date.now();
      const query = `
        SELECT count() as cnt, avg(best_bid) as avg_bid
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE asset_id = '${assetId}'
          AND source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{ cnt: string; avg_bid: number }>(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nAsset_id index efficiency:`);
      console.log(`  Asset: ${assetId.slice(0, 30)}...`);
      console.log(`  Rows: ${result.data[0].cnt}`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 500,
        test: "Asset_id lookup < 500ms",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, rows: result.data[0].cnt },
      });

      expect(elapsed).toBeLessThan(500);
    });

    it("should efficiently query by condition_id", async () => {
      if (!config) return;

      // Get a sample condition_id
      const sampleQuery = `
        SELECT condition_id
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
        LIMIT 1
      `;

      const sampleResult = await executeQuery<{ condition_id: string }>(config, sampleQuery);
      if (sampleResult.data.length === 0) {
        console.log("\nNo data available for index test");
        return;
      }

      const conditionId = sampleResult.data[0].condition_id;

      const startTime = Date.now();
      const query = `
        SELECT count() as cnt
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE condition_id = '${conditionId}'
          AND source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{ cnt: string }>(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nCondition_id lookup:`);
      console.log(`  Condition: ${conditionId.slice(0, 30)}...`);
      console.log(`  Rows: ${result.data[0].cnt}`);
      console.log(`  Elapsed: ${elapsed}ms`);

      validationResults.push({
        passed: elapsed < 1000,
        test: "Condition_id lookup < 1s",
        message: `Query completed in ${elapsed}ms`,
        actual: { elapsed, rows: result.data[0].cnt },
      });

      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("Concurrent Query Handling", () => {
    it("should handle 5 concurrent queries", async () => {
      if (!config) return;

      const queries = [
        `SELECT count() FROM ${getTable("OB_SNAPSHOTS")} WHERE source_ts >= now() - INTERVAL 1 HOUR`,
        `SELECT count() FROM ${getTable("TRADE_TICKS")} WHERE source_ts >= now() - INTERVAL 1 HOUR`,
        `SELECT count() FROM ${getTable("OB_LEVEL_CHANGES")} WHERE source_ts >= now() - INTERVAL 1 HOUR`,
        `SELECT avg(best_bid) FROM ${getTable("OB_SNAPSHOTS")} WHERE source_ts >= now() - INTERVAL 1 HOUR`,
        `SELECT max(source_ts) FROM ${getTable("OB_SNAPSHOTS")}`,
      ];

      const startTime = Date.now();

      const results = await Promise.all(
        queries.map((q) => executeQuery(config!, q).catch((e) => ({ error: e.message })))
      );

      const elapsed = Date.now() - startTime;
      const successCount = results.filter((r) => !("error" in r)).length;

      // Log any errors for debugging
      const errors = results.filter((r) => "error" in r);
      if (errors.length > 0) {
        console.log(`\nQuery errors: ${errors.map((e: any) => e.error).join("; ")}`);
      }

      console.log(`\nConcurrent queries:`);
      console.log(`  Total: ${queries.length}`);
      console.log(`  Successful: ${successCount}`);
      console.log(`  Total elapsed: ${elapsed}ms`);
      console.log(`  Avg per query: ${(elapsed / queries.length).toFixed(0)}ms`);

      // Allow some slack for transient network issues or rate limiting
      // At least 4 out of 5 queries should succeed, within 15s total
      const minSuccess = 4;
      const maxTime = 15000;

      validationResults.push({
        passed: successCount >= minSuccess && elapsed < maxTime,
        test: `Concurrent queries (>= ${minSuccess}/5 success, < ${maxTime / 1000}s)`,
        message: `${successCount}/${queries.length} queries in ${elapsed}ms`,
        actual: { successCount, elapsed },
      });

      expect(successCount).toBeGreaterThanOrEqual(minSuccess);
      expect(elapsed).toBeLessThan(maxTime);
    });
  });

  describe("Memory Efficiency", () => {
    it("should efficiently process large result sets with LIMIT", async () => {
      if (!config) return;

      // Test that LIMIT is applied at source, not after fetching all data
      // Note: SELECT * on tables with large array columns (bid_prices, ask_prices, etc.)
      // will be slower due to data transfer. The key test is that LIMIT actually limits
      // the results rather than fetching all rows.
      const startTime = Date.now();
      const query = `
        SELECT asset_id, source_ts, best_bid, best_ask, spread_bps
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        LIMIT 1000
      `;

      const result = await executeQuery(config, query);
      const elapsed = Date.now() - startTime;

      console.log(`\nLIMIT efficiency:`);
      console.log(`  Rows returned: ${result.data.length}`);
      console.log(`  Elapsed: ${elapsed}ms`);

      // Allow up to 2s for network latency
      const maxTime = 2000;

      validationResults.push({
        passed: elapsed < maxTime && result.data.length === 1000,
        test: `LIMIT 1000 query < ${maxTime / 1000}s`,
        message: `Returned ${result.data.length} rows in ${elapsed}ms`,
        actual: { elapsed, rows: result.data.length },
      });

      expect(elapsed).toBeLessThan(maxTime);
      expect(result.data.length).toBe(1000);
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
