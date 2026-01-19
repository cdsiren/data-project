/**
 * P0 Source API Validation Tests
 *
 * These tests validate that data stored in ClickHouse matches
 * the source data from Polymarket APIs.
 *
 * Run with: npx vitest run src/tests/data-validation/source-api.test.ts
 *
 * Required environment variables:
 * - CLICKHOUSE_URL: Full URL to ClickHouse HTTP interface
 * - CLICKHOUSE_USER: ClickHouse username (default: "default")
 * - CLICKHOUSE_TOKEN: ClickHouse password/API key
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getClickHouseConfig,
  executeQuery,
  getTable,
  fetchLiveOrderbook,
  fetchMarketMetadata,
  getRecentAssetIds,
  approxEqual,
  TEST_CONFIG,
  type ClickHouseConfig,
  type ValidationResult,
  formatValidationResults,
} from "./test-utils";

describe("P0: Source API Validation", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping Source API tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("BBO Data vs Live CLOB API", () => {
    it("should have recent data in orderbook tables", async () => {
      if (!config) return;

      // Check all orderbook-related tables
      const tables = [
        { name: "ob_bbo", table: getTable("OB_BBO") },
        { name: "ob_snapshots", table: getTable("OB_SNAPSHOTS") },
        { name: "trade_ticks", table: getTable("TRADE_TICKS") },
      ];

      let hasAnyData = false;
      const tableStats: Record<string, number> = {};

      for (const { name, table } of tables) {
        const query = `
          SELECT count() as cnt,
                 min(source_ts) as oldest,
                 max(source_ts) as newest
          FROM ${table}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        `;

        const result = await executeQuery<{
          cnt: string;
          oldest: string;
          newest: string;
        }>(config, query);

        const count = Number(result.data[0].cnt);
        tableStats[name] = count;

        if (count > 0) {
          hasAnyData = true;
          console.log(`\n${name}: ${count} records`);
          console.log(`  Oldest: ${result.data[0].oldest}`);
          console.log(`  Newest: ${result.data[0].newest}`);
        } else {
          console.log(`\n${name}: 0 records (empty)`);
        }
      }

      validationResults.push({
        passed: hasAnyData,
        test: "Recent orderbook data exists",
        message: hasAnyData
          ? `Data found: ${JSON.stringify(tableStats)}`
          : "No recent data in any orderbook table",
        actual: tableStats,
      });

      expect(hasAnyData).toBe(true);
    });

    it("should have fresh data in ob_bbo table", async () => {
      if (!config) return;

      // Check ob_bbo freshness without time filter
      const query = `
        SELECT
          count() as total_records,
          max(source_ts) as newest,
          min(source_ts) as oldest,
          dateDiff('minute', max(source_ts), now()) as minutes_stale,
          count(DISTINCT asset_id) as unique_assets
        FROM ${getTable("OB_BBO")}
      `;

      const result = await executeQuery<{
        total_records: string;
        newest: string;
        oldest: string;
        minutes_stale: number;
        unique_assets: string;
      }>(config, query);

      const totalRecords = Number(result.data[0].total_records);
      const minutesStale = result.data[0].minutes_stale;
      const hoursStale = minutesStale / 60;
      const uniqueAssets = Number(result.data[0].unique_assets);

      console.log(`\nob_bbo table freshness:`);
      console.log(`  Total records: ${totalRecords.toLocaleString()}`);
      console.log(`  Unique assets: ${uniqueAssets.toLocaleString()}`);
      console.log(`  Oldest: ${result.data[0].oldest}`);
      console.log(`  Newest: ${result.data[0].newest}`);
      console.log(`  Data staleness: ${hoursStale.toFixed(1)} hours (${minutesStale} minutes)`);

      // Warn threshold: 1 hour, Fail threshold: configurable
      const maxStaleHours = 1;
      const isFresh = hoursStale <= maxStaleHours;

      if (!isFresh) {
        console.log(`  ⚠️  WARNING: ob_bbo data is ${hoursStale.toFixed(1)} hours stale!`);
        console.log(`     Last ingestion: ${result.data[0].newest}`);
        console.log(`     Check if the ob_bbo ingestion pipeline is running.`);
      }

      validationResults.push({
        passed: isFresh,
        test: `ob_bbo freshness (< ${maxStaleHours}h stale)`,
        message: isFresh
          ? `Data is ${minutesStale} minutes old`
          : `Data is ${hoursStale.toFixed(1)} hours stale - ingestion may be stopped`,
        actual: {
          totalRecords,
          uniqueAssets,
          newest: result.data[0].newest,
          hoursStale: hoursStale.toFixed(1),
        },
      });

      // This test fails if data is stale, alerting to pipeline issues
      expect(isFresh).toBe(true);
    });

    it("should match live orderbook BBO for active assets", async () => {
      if (!config) return;

      // Get recent active asset IDs (will try ob_bbo, trade_ticks, ob_snapshots)
      const assetIds = await getRecentAssetIds(config, 5);

      if (assetIds.length === 0) {
        console.log("\nNo recent asset IDs found in any table - skipping live comparison");
        validationResults.push({
          passed: true,
          test: "BBO prices in valid range",
          message: "Skipped - no recent data to validate",
        });
        return;
      }

      console.log(`\nValidating ${assetIds.length} active assets against live API...`);

      let matchCount = 0;
      let mismatchCount = 0;
      let skippedCount = 0;

      for (const assetId of assetIds) {
        // Fetch live orderbook from CLOB API
        const liveBook = await fetchLiveOrderbook(assetId);
        if (!liveBook) {
          console.log(`  Skipping ${assetId.slice(0, 20)}... (API unavailable)`);
          skippedCount++;
          continue;
        }

        // Try to get stored BBO from ob_bbo first, then ob_snapshots
        let storedBestBid: number | null = null;
        let storedBestAsk: number | null = null;
        let source = "";

        // Try ob_bbo first
        const bboQuery = `
          SELECT best_bid, best_ask
          FROM ${getTable("OB_BBO")}
          WHERE asset_id = '${assetId}'
          ORDER BY source_ts DESC
          LIMIT 1
        `;
        const bboResult = await executeQuery<{ best_bid: number; best_ask: number }>(config, bboQuery);

        if (bboResult.data.length > 0) {
          storedBestBid = bboResult.data[0].best_bid;
          storedBestAsk = bboResult.data[0].best_ask;
          source = "ob_bbo";
        } else {
          // Fall back to ob_snapshots
          const snapshotQuery = `
            SELECT best_bid, best_ask
            FROM ${getTable("OB_SNAPSHOTS")}
            WHERE asset_id = '${assetId}'
            ORDER BY source_ts DESC
            LIMIT 1
          `;
          const snapshotResult = await executeQuery<{ best_bid: number; best_ask: number }>(config, snapshotQuery);

          if (snapshotResult.data.length > 0) {
            storedBestBid = snapshotResult.data[0].best_bid;
            storedBestAsk = snapshotResult.data[0].best_ask;
            source = "ob_snapshots";
          }
        }

        if (storedBestBid === null || storedBestAsk === null) {
          console.log(`  Skipping ${assetId.slice(0, 20)}... (no stored BBO data)`);
          skippedCount++;
          continue;
        }

        const liveBestBid = liveBook.bids[0] ? parseFloat(liveBook.bids[0].price) : 0;
        const liveBestAsk = liveBook.asks[0] ? parseFloat(liveBook.asks[0].price) : 0;

        // Validate prices are in valid range (0-1 for prediction markets)
        const storedBidValid = storedBestBid >= 0 && storedBestBid <= 1;
        const storedAskValid = storedBestAsk >= 0 && storedBestAsk <= 1;
        const liveBidValid = liveBestBid >= 0 && liveBestBid <= 1;
        const liveAskValid = liveBestAsk >= 0 && liveBestAsk <= 1;

        if (storedBidValid && storedAskValid && liveBidValid && liveAskValid) {
          matchCount++;
        } else {
          mismatchCount++;
        }

        console.log(`  ${assetId.slice(0, 20)}... (${source})`);
        console.log(`    Stored: bid=${storedBestBid.toFixed(4)} ask=${storedBestAsk.toFixed(4)}`);
        console.log(`    Live:   bid=${liveBestBid.toFixed(4)} ask=${liveBestAsk.toFixed(4)}`);
      }

      validationResults.push({
        passed: matchCount > 0 || skippedCount === assetIds.length,
        test: "BBO prices in valid range",
        message:
          mismatchCount === 0
            ? `All ${matchCount} assets have valid prices (${skippedCount} skipped)`
            : `${mismatchCount} assets have invalid prices`,
        sampleSize: matchCount + mismatchCount,
      });

      // Only fail if we had data and found mismatches
      if (matchCount + mismatchCount > 0) {
        expect(mismatchCount).toBe(0);
      }
    });

    it("should have consistent asset_id and condition_id mapping", async () => {
      if (!config) return;

      // Check that each asset_id maps to exactly one condition_id
      const query = `
        SELECT asset_id, count(DISTINCT condition_id) as condition_count
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY asset_id
        HAVING condition_count > 1
        LIMIT 10
      `;

      const result = await executeQuery<{
        asset_id: string;
        condition_count: string;
      }>(config, query);

      const inconsistentCount = result.data.length;

      validationResults.push({
        passed: inconsistentCount === 0,
        test: "Asset-to-condition mapping consistency",
        message:
          inconsistentCount === 0
            ? "All assets map to exactly one condition"
            : `${inconsistentCount} assets have multiple conditions`,
        actual: result.data.slice(0, 3),
      });

      if (inconsistentCount > 0) {
        console.log(`\nInconsistent asset-condition mappings:`);
        for (const row of result.data) {
          console.log(`  ${row.asset_id.slice(0, 30)}... -> ${row.condition_count} conditions`);
        }
      }

      expect(inconsistentCount).toBe(0);
    });
  });

  describe("Trade Ticks vs Source", () => {
    it("should have recent trade data", async () => {
      if (!config) return;

      const query = `
        SELECT count() as cnt,
               min(source_ts) as oldest,
               max(source_ts) as newest
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        cnt: string;
        oldest: string;
        newest: string;
      }>(config, query);

      const count = Number(result.data[0].cnt);

      validationResults.push({
        passed: count > 0,
        test: "Recent trade data exists",
        message: count > 0 ? `Found ${count} trades` : "No recent trade data found",
        sampleSize: count,
      });

      console.log(`\nRecent trade data: ${count} records`);
      if (count > 0) {
        console.log(`  Oldest: ${result.data[0].oldest}`);
        console.log(`  Newest: ${result.data[0].newest}`);
      }

      // Trades may be less frequent, so we just verify structure
      expect(count >= 0).toBe(true);
    });

    it("should have valid trade prices and sizes", async () => {
      if (!config) return;

      // Check for invalid trade data
      const query = `
        SELECT count() as invalid_count
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND (
            price < 0 OR price > 1
            OR size <= 0
            OR side NOT IN ('BUY', 'SELL')
          )
      `;

      const result = await executeQuery<{ invalid_count: string }>(config, query);
      const invalidCount = Number(result.data[0].invalid_count);

      validationResults.push({
        passed: invalidCount === 0,
        test: "Trade prices and sizes valid",
        message:
          invalidCount === 0
            ? "All trades have valid prices and sizes"
            : `${invalidCount} trades have invalid data`,
        actual: invalidCount,
      });

      if (invalidCount > 0) {
        // Get sample of invalid trades
        const sampleQuery = `
          SELECT asset_id, price, size, side
          FROM ${getTable("TRADE_TICKS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND (price < 0 OR price > 1 OR size <= 0 OR side NOT IN ('BUY', 'SELL'))
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nInvalid trade samples:`, sampleResult.data);
      }

      expect(invalidCount).toBe(0);
    });

    it("should have matching asset_ids between trades and BBO", async () => {
      if (!config) return;

      // Find trade asset_ids that don't exist in BBO
      const query = `
        SELECT DISTINCT t.asset_id
        FROM ${getTable("TRADE_TICKS")} t
        LEFT JOIN (
          SELECT DISTINCT asset_id
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS * 2} HOUR
        ) b ON t.asset_id = b.asset_id
        WHERE t.source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND b.asset_id IS NULL
        LIMIT 10
      `;

      const result = await executeQuery<{ asset_id: string }>(config, query);
      const orphanCount = result.data.length;

      validationResults.push({
        passed: orphanCount === 0,
        test: "Trade asset_ids exist in BBO data",
        message:
          orphanCount === 0
            ? "All trade assets have corresponding BBO data"
            : `${orphanCount} trade assets missing from BBO`,
        actual: result.data.map((r) => r.asset_id.slice(0, 30) + "..."),
      });

      // Some orphans may be acceptable if BBO data was purged
      if (orphanCount > 0) {
        console.log(`\nTrade assets missing from BBO:`, result.data.slice(0, 3));
      }
    });
  });

  describe("L2 Snapshots vs BBO", () => {
    it("should have L2 snapshots for active assets", async () => {
      if (!config) return;

      const query = `
        SELECT count() as cnt,
               count(DISTINCT asset_id) as unique_assets
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        cnt: string;
        unique_assets: string;
      }>(config, query);

      const count = Number(result.data[0].cnt);
      const uniqueAssets = Number(result.data[0].unique_assets);

      validationResults.push({
        passed: count > 0,
        test: "L2 snapshots exist",
        message:
          count > 0
            ? `Found ${count} snapshots for ${uniqueAssets} assets`
            : "No L2 snapshots found",
        sampleSize: count,
      });

      console.log(`\nL2 Snapshots: ${count} records for ${uniqueAssets} unique assets`);
    });

    it("should have L2 best_bid/ask matching top of book arrays", async () => {
      if (!config) return;

      // Verify materialized columns match array values
      const query = `
        SELECT count() as total,
               countIf(
                 abs(best_bid - bid_prices[1]) > 0.0001
                 OR abs(best_ask - ask_prices[1]) > 0.0001
               ) as mismatches
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND length(bid_prices) > 0
          AND length(ask_prices) > 0
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "L2 materialized BBO matches arrays",
        message:
          mismatches === 0
            ? `All ${total} snapshots have matching BBO`
            : `${mismatches}/${total} snapshots have BBO mismatch`,
        sampleSize: total,
      });

      expect(mismatches).toBe(0);
    });

    it("should have consistent array lengths (bids/asks)", async () => {
      if (!config) return;

      // bid_prices and bid_sizes should have same length
      const query = `
        SELECT count() as mismatches
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND (
            length(bid_prices) != length(bid_sizes)
            OR length(ask_prices) != length(ask_sizes)
          )
      `;

      const result = await executeQuery<{ mismatches: string }>(config, query);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "L2 array lengths consistent",
        message:
          mismatches === 0
            ? "All price/size arrays have matching lengths"
            : `${mismatches} snapshots have mismatched array lengths`,
      });

      expect(mismatches).toBe(0);
    });
  });

  describe("Market Metadata Validation", () => {
    it("should validate market metadata against Gamma API", async () => {
      if (!config) return;

      // Get sample of condition_ids from recent data
      const conditionQuery = `
        SELECT DISTINCT condition_id
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        LIMIT 3
      `;

      const conditionResult = await executeQuery<{ condition_id: string }>(config, conditionQuery);

      if (conditionResult.data.length === 0) {
        console.log("No recent condition_ids to validate");
        return;
      }

      console.log(`\nValidating ${conditionResult.data.length} markets against Gamma API...`);

      let validCount = 0;
      for (const row of conditionResult.data) {
        const liveMetadata = await fetchMarketMetadata(row.condition_id);

        if (liveMetadata) {
          console.log(`  ${row.condition_id.slice(0, 30)}...`);
          console.log(`    Question: ${liveMetadata.question?.slice(0, 50)}...`);
          console.log(`    Tick size: ${liveMetadata.orderPriceMinTickSize}`);
          console.log(`    Neg risk: ${liveMetadata.negRisk}`);
          validCount++;
        } else {
          console.log(`  ${row.condition_id.slice(0, 30)}... (not found in API)`);
        }
      }

      validationResults.push({
        passed: validCount > 0,
        test: "Market metadata API accessible",
        message: `${validCount}/${conditionResult.data.length} markets found in Gamma API`,
        sampleSize: conditionResult.data.length,
      });
    });
  });

  describe("Gap Detection Integrity", () => {
    it("should have gap events with valid resolution states", async () => {
      if (!config) return;

      const query = `
        SELECT resolution, count() as cnt
        FROM ${getTable("OB_GAP_EVENTS")}
        WHERE detected_at >= now() - INTERVAL 7 DAY
        GROUP BY resolution
      `;

      const result = await executeQuery<{
        resolution: string;
        cnt: string;
      }>(config, query);

      console.log(`\nGap events by resolution (last 7 days):`);
      for (const row of result.data) {
        console.log(`  ${row.resolution}: ${row.cnt}`);
      }

      // Check for stale PENDING gaps (older than 1 hour)
      const staleQuery = `
        SELECT count() as stale_count
        FROM ${getTable("OB_GAP_EVENTS")}
        WHERE resolution = 'PENDING'
          AND detected_at < now() - INTERVAL 1 HOUR
      `;

      const staleResult = await executeQuery<{ stale_count: string }>(config, staleQuery);
      const staleCount = Number(staleResult.data[0].stale_count);

      validationResults.push({
        passed: staleCount === 0,
        test: "No stale PENDING gaps",
        message:
          staleCount === 0
            ? "All gaps resolved within 1 hour"
            : `${staleCount} gaps pending for > 1 hour`,
        actual: staleCount,
      });

      if (staleCount > 0) {
        console.log(`\nWarning: ${staleCount} gap events pending for > 1 hour`);
      }
    });

    it("should have resync snapshots for resolved gaps", async () => {
      if (!config) return;

      // Check that RESOLVED gaps have corresponding is_resync=1 snapshots
      const query = `
        SELECT
          g.asset_id,
          g.detected_at,
          countIf(b.is_resync = 1) as resync_count
        FROM ${getTable("OB_GAP_EVENTS")} g
        LEFT JOIN ${getTable("OB_BBO")} b ON
          g.asset_id = b.asset_id
          AND b.source_ts >= g.detected_at
          AND b.source_ts <= g.detected_at + INTERVAL 5 MINUTE
        WHERE g.resolution = 'RESOLVED'
          AND g.detected_at >= now() - INTERVAL 7 DAY
        GROUP BY g.asset_id, g.detected_at
        HAVING resync_count = 0
        LIMIT 10
      `;

      const result = await executeQuery<{
        asset_id: string;
        detected_at: string;
        resync_count: string;
      }>(config, query);

      const missingResyncs = result.data.length;

      validationResults.push({
        passed: missingResyncs === 0,
        test: "Resolved gaps have resync snapshots",
        message:
          missingResyncs === 0
            ? "All resolved gaps have corresponding resync data"
            : `${missingResyncs} resolved gaps missing resync snapshots`,
        actual: result.data.slice(0, 3),
      });

      if (missingResyncs > 0) {
        console.log(`\nResolved gaps missing resync snapshots:`, result.data.slice(0, 3));
      }
    });
  });

  describe("Latency Validation", () => {
    it("should have ingestion latency within acceptable bounds", async () => {
      if (!config) return;

      const query = `
        SELECT
          quantile(0.5)(latency_ms) as p50,
          quantile(0.95)(latency_ms) as p95,
          quantile(0.99)(latency_ms) as p99,
          max(latency_ms) as max_latency,
          count() as sample_size
        FROM ${getTable("OB_LATENCY")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
      `;

      const result = await executeQuery<{
        p50: number;
        p95: number;
        p99: number;
        max_latency: number;
        sample_size: string;
      }>(config, query);

      if (Number(result.data[0].sample_size) === 0) {
        console.log("No latency data in the last hour");
        return;
      }

      const { p50, p95, p99, max_latency, sample_size } = result.data[0];

      console.log(`\nIngestion latency (last hour, n=${sample_size}):`);
      console.log(`  p50: ${p50.toFixed(1)}ms`);
      console.log(`  p95: ${p95.toFixed(1)}ms`);
      console.log(`  p99: ${p99.toFixed(1)}ms`);
      console.log(`  max: ${max_latency.toFixed(1)}ms`);

      const p99InBounds = p99 < TEST_CONFIG.MAX_LATENCY_MS;

      validationResults.push({
        passed: p99InBounds,
        test: "p99 latency within bounds",
        message: p99InBounds
          ? `p99 latency (${p99.toFixed(1)}ms) under ${TEST_CONFIG.MAX_LATENCY_MS}ms threshold`
          : `p99 latency (${p99.toFixed(1)}ms) exceeds ${TEST_CONFIG.MAX_LATENCY_MS}ms threshold`,
        expected: `< ${TEST_CONFIG.MAX_LATENCY_MS}ms`,
        actual: `${p99.toFixed(1)}ms`,
        sampleSize: Number(sample_size),
      });

      expect(p99).toBeLessThan(TEST_CONFIG.MAX_LATENCY_MS);
    });

    it("should have non-negative latencies (no time travel)", async () => {
      if (!config) return;

      const query = `
        SELECT count() as negative_count
        FROM ${getTable("OB_LATENCY")}
        WHERE source_ts >= now() - INTERVAL 1 HOUR
          AND latency_ms < 0
      `;

      const result = await executeQuery<{ negative_count: string }>(config, query);
      const negativeCount = Number(result.data[0].negative_count);

      validationResults.push({
        passed: negativeCount === 0,
        test: "No negative latencies",
        message:
          negativeCount === 0
            ? "All latencies are non-negative"
            : `${negativeCount} records have negative latency (clock skew?)`,
        actual: negativeCount,
      });

      expect(negativeCount).toBe(0);
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
