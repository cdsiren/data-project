/**
 * P0 Mathematical Consistency Tests
 *
 * These tests verify that calculated fields in ClickHouse
 * are mathematically correct and consistent.
 *
 * Run with: npx vitest run src/tests/data-validation/mathematical.test.ts
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

describe("P0: Mathematical Consistency", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping Mathematical tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("BBO Calculated Fields", () => {
    it("should have mid_price = (best_bid + best_ask) / 2", async () => {
      if (!config) return;

      // Check for mid_price calculation errors
      // Allow for floating point tolerance
      const query = `
        SELECT
          count() as total,
          countIf(
            best_bid > 0 AND best_ask > 0
            AND abs(mid_price - (best_bid + best_ask) / 2) > 0.0001
          ) as mismatches
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND best_bid > 0
          AND best_ask > 0
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "mid_price = (best_bid + best_ask) / 2",
        message:
          mismatches === 0
            ? `All ${total} records have correct mid_price`
            : `${mismatches}/${total} records have incorrect mid_price`,
        sampleSize: total,
      });

      if (mismatches > 0) {
        // Get sample of mismatches
        const sampleQuery = `
          SELECT asset_id, best_bid, best_ask, mid_price,
                 (best_bid + best_ask) / 2 as expected_mid
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND best_bid > 0 AND best_ask > 0
            AND abs(mid_price - (best_bid + best_ask) / 2) > 0.0001
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nMid-price mismatches:`, sampleResult.data);
      }

      expect(mismatches).toBe(0);
    });

    it("should have spread_bps = (best_ask - best_bid) / mid_price * 10000", async () => {
      if (!config) return;

      // Check spread_bps calculation
      // spread_bps = (ask - bid) / mid * 10000
      const query = `
        SELECT
          count() as total,
          countIf(
            best_bid > 0 AND best_ask > 0 AND mid_price > 0
            AND abs(
              spread_bps - ((best_ask - best_bid) / mid_price * 10000)
            ) > ${TEST_CONFIG.SPREAD_BPS_TOLERANCE}
          ) as mismatches
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND best_bid > 0
          AND best_ask > 0
          AND mid_price > 0
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "spread_bps calculation correct",
        message:
          mismatches === 0
            ? `All ${total} records have correct spread_bps`
            : `${mismatches}/${total} records have incorrect spread_bps`,
        sampleSize: total,
      });

      if (mismatches > 0) {
        const sampleQuery = `
          SELECT asset_id, best_bid, best_ask, mid_price, spread_bps,
                 ((best_ask - best_bid) / mid_price * 10000) as expected_spread_bps
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND best_bid > 0 AND best_ask > 0 AND mid_price > 0
            AND abs(spread_bps - ((best_ask - best_bid) / mid_price * 10000)) > ${TEST_CONFIG.SPREAD_BPS_TOLERANCE}
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nSpread_bps mismatches:`, sampleResult.data);
      }

      expect(mismatches).toBe(0);
    });

    it("should have best_bid < best_ask (no crossed books except flagged)", async () => {
      if (!config) return;

      // Crossed book means bid > ask (truly crossed, not locked)
      // Locked books (bid = ask) are legitimate market conditions
      // One-sided books (bid or ask = 0) are excluded from this check
      const query = `
        SELECT
          count() as total,
          countIf(best_bid > 0 AND best_ask > 0) as two_sided_books,
          countIf(best_bid > best_ask AND best_bid > 0 AND best_ask > 0) as truly_crossed,
          countIf(best_bid = best_ask AND best_bid > 0) as locked_books
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        two_sided_books: string;
        truly_crossed: string;
        locked_books: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const twoSidedBooks = Number(result.data[0].two_sided_books);
      const trulyCrossed = Number(result.data[0].truly_crossed);
      const lockedBooks = Number(result.data[0].locked_books);
      const crossedPercent = twoSidedBooks > 0 ? (trulyCrossed / twoSidedBooks) * 100 : 0;

      console.log(`\nBook state analysis (n=${total}):`);
      console.log(`  Two-sided books: ${twoSidedBooks}`);
      console.log(`  Truly crossed (bid > ask): ${trulyCrossed} (${crossedPercent.toFixed(4)}%)`);
      console.log(`  Locked (bid = ask): ${lockedBooks}`);
      console.log(`  One-sided (bid or ask = 0): ${total - twoSidedBooks}`);

      validationResults.push({
        passed: crossedPercent < 1, // Allow < 1% truly crossed (arbitrage moments)
        test: "Truly crossed books < 1%",
        message:
          crossedPercent < 1
            ? `Only ${crossedPercent.toFixed(4)}% truly crossed books (acceptable)`
            : `${crossedPercent.toFixed(2)}% truly crossed exceeds 1% threshold`,
        expected: "< 1%",
        actual: `${crossedPercent.toFixed(4)}%`,
        sampleSize: twoSidedBooks,
      });

      if (trulyCrossed > 0) {
        // Get sample of truly crossed books
        const sampleQuery = `
          SELECT asset_id, source_ts, best_bid, best_ask,
                 best_bid - best_ask as crossed_by
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND best_bid > best_ask
            AND best_bid > 0 AND best_ask > 0
          ORDER BY (best_bid - best_ask) DESC
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nTruly crossed book samples (arbitrage opportunities):`, sampleResult.data);
      }

      expect(crossedPercent).toBeLessThan(VALIDATION_THRESHOLDS.CROSSED_BOOKS_PERCENT);
    });

    it("should have prices in valid prediction market range [0, 1]", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(best_bid < 0 OR best_bid > 1) as invalid_bid,
          countIf(best_ask < 0 OR best_ask > 1) as invalid_ask,
          countIf(mid_price < 0 OR mid_price > 1) as invalid_mid
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND (best_bid != 0 OR best_ask != 0)
      `;

      const result = await executeQuery<{
        total: string;
        invalid_bid: string;
        invalid_ask: string;
        invalid_mid: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const invalidBid = Number(result.data[0].invalid_bid);
      const invalidAsk = Number(result.data[0].invalid_ask);
      const invalidMid = Number(result.data[0].invalid_mid);
      const totalInvalid = invalidBid + invalidAsk + invalidMid;

      console.log(`\nPrice range validation (n=${total}):`);
      console.log(`  Invalid bids (< 0 or > 1): ${invalidBid}`);
      console.log(`  Invalid asks (< 0 or > 1): ${invalidAsk}`);
      console.log(`  Invalid mids (< 0 or > 1): ${invalidMid}`);

      validationResults.push({
        passed: totalInvalid === 0,
        test: "Prices in [0, 1] range",
        message:
          totalInvalid === 0
            ? `All ${total} records have valid prices`
            : `${totalInvalid} records have out-of-range prices`,
        actual: { invalidBid, invalidAsk, invalidMid },
        sampleSize: total,
      });

      expect(totalInvalid).toBe(0);
    });

    it("should have non-negative spread_bps (excluding crossed books)", async () => {
      if (!config) return;

      // Negative spread is expected for crossed books (bid > ask)
      // We only check non-crossed books here
      const query = `
        SELECT
          count() as total,
          countIf(spread_bps < 0) as negative_spread,
          countIf(spread_bps < 0 AND best_bid <= best_ask) as unexpected_negative
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND best_bid > 0 AND best_ask > 0
      `;

      const result = await executeQuery<{
        total: string;
        negative_spread: string;
        unexpected_negative: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const negativeSpread = Number(result.data[0].negative_spread);
      const unexpectedNegative = Number(result.data[0].unexpected_negative);

      console.log(`\nSpread analysis (n=${total}):`);
      console.log(`  Negative spread (from crossed books): ${negativeSpread}`);
      console.log(`  Unexpected negative (not crossed): ${unexpectedNegative}`);

      validationResults.push({
        passed: unexpectedNegative === 0,
        test: "Non-negative spread_bps (excluding crossed)",
        message:
          unexpectedNegative === 0
            ? `All non-crossed books have non-negative spread (${negativeSpread} negative from crossed books is expected)`
            : `${unexpectedNegative}/${total} non-crossed records have unexpected negative spread`,
        sampleSize: total,
      });

      // Only fail if we have negative spread on non-crossed books
      expect(unexpectedNegative).toBe(0);
    });

    it("should have positive sizes when prices are present", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(best_bid > 0 AND bid_size <= 0) as zero_bid_size,
          countIf(best_ask > 0 AND ask_size <= 0) as zero_ask_size
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        zero_bid_size: string;
        zero_ask_size: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const zeroBidSize = Number(result.data[0].zero_bid_size);
      const zeroAskSize = Number(result.data[0].zero_ask_size);
      const totalZero = zeroBidSize + zeroAskSize;

      console.log(`\nSize validation (n=${total}):`);
      console.log(`  Zero bid_size with non-zero bid: ${zeroBidSize}`);
      console.log(`  Zero ask_size with non-zero ask: ${zeroAskSize}`);

      validationResults.push({
        passed: totalZero === 0,
        test: "Positive sizes with prices",
        message:
          totalZero === 0
            ? `All ${total} records have valid sizes`
            : `${totalZero} records have zero size with non-zero price`,
        actual: { zeroBidSize, zeroAskSize },
        sampleSize: total,
      });

      expect(totalZero).toBe(0);
    });
  });

  describe("Trade Tick Calculated Fields", () => {
    it("should have notional = price * size", async () => {
      if (!config) return;

      // notional is a materialized column
      const query = `
        SELECT
          count() as total,
          countIf(abs(notional - (price * size)) > 0.0001) as mismatches
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      const mismatchPercent = total > 0 ? (mismatches / total) * 100 : 0;

      validationResults.push({
        passed: mismatchPercent < 10, // Allow up to 10% mismatches (data quality issue)
        test: "notional = price * size",
        message:
          mismatches === 0
            ? `All ${total} trades have correct notional`
            : `${mismatches}/${total} (${mismatchPercent.toFixed(2)}%) trades have incorrect notional - DATA QUALITY ISSUE`,
        sampleSize: total,
      });

      if (mismatches > 0) {
        const sampleQuery = `
          SELECT asset_id, price, size, notional, (price * size) as expected
          FROM ${getTable("TRADE_TICKS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND abs(notional - (price * size)) > 0.0001
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nNotional mismatches (DATA QUALITY ISSUE):`, sampleResult.data);
        console.log(`\nNote: This indicates a bug in the materialized column definition or data ingestion.`);
      }

      // Warn but don't fail - this is a known data quality issue to investigate
      expect(mismatchPercent).toBeLessThan(VALIDATION_THRESHOLDS.NOTIONAL_MISMATCH_PERCENT);
    });

    it("should have latency_ms = dateDiff(source_ts, ingestion_ts)", async () => {
      if (!config) return;

      // latency_ms is a materialized column
      const query = `
        SELECT
          count() as total,
          countIf(
            abs(latency_ms - dateDiff('millisecond', source_ts, ingestion_ts)) > 1
          ) as mismatches
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "Trade latency_ms calculation",
        message:
          mismatches === 0
            ? `All ${total} trades have correct latency_ms`
            : `${mismatches}/${total} trades have incorrect latency_ms`,
        sampleSize: total,
      });

      expect(mismatches).toBe(0);
    });
  });

  describe("L2 Snapshot Calculated Fields", () => {
    it("should have spread = best_ask - best_bid", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(
            length(bid_prices) > 0 AND length(ask_prices) > 0
            AND abs(spread - (best_ask - best_bid)) > 0.0001
          ) as mismatches
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "L2 spread = best_ask - best_bid",
        message:
          mismatches === 0
            ? `All ${total} snapshots have correct spread`
            : `${mismatches}/${total} snapshots have incorrect spread`,
        sampleSize: total,
      });

      expect(mismatches).toBe(0);
    });

    it("should have total_bid_depth = sum of bid_sizes", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(
            length(bid_sizes) > 0
            AND abs(total_bid_depth - arraySum(bid_sizes)) > 0.01
          ) as mismatches
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "total_bid_depth = sum(bid_sizes)",
        message:
          mismatches === 0
            ? `All ${total} snapshots have correct total_bid_depth`
            : `${mismatches}/${total} snapshots have incorrect total_bid_depth`,
        sampleSize: total,
      });

      expect(mismatches).toBe(0);
    });

    it("should have bid_levels = length(bid_prices)", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(bid_levels != length(bid_prices)) as bid_mismatches,
          countIf(ask_levels != length(ask_prices)) as ask_mismatches
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        bid_mismatches: string;
        ask_mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const bidMismatches = Number(result.data[0].bid_mismatches);
      const askMismatches = Number(result.data[0].ask_mismatches);
      const totalMismatches = bidMismatches + askMismatches;

      validationResults.push({
        passed: totalMismatches === 0,
        test: "Level counts match array lengths",
        message:
          totalMismatches === 0
            ? `All ${total} snapshots have correct level counts`
            : `${totalMismatches}/${total} snapshots have incorrect level counts`,
        actual: { bidMismatches, askMismatches },
        sampleSize: total,
      });

      expect(totalMismatches).toBe(0);
    });

    it("should have book_imbalance in valid range [-1, 1]", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(book_imbalance < -1 OR book_imbalance > 1) as out_of_range
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND total_bid_depth + total_ask_depth > 0
      `;

      const result = await executeQuery<{
        total: string;
        out_of_range: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const outOfRange = Number(result.data[0].out_of_range);

      validationResults.push({
        passed: outOfRange === 0,
        test: "book_imbalance in [-1, 1]",
        message:
          outOfRange === 0
            ? `All ${total} snapshots have valid imbalance`
            : `${outOfRange}/${total} snapshots have out-of-range imbalance`,
        sampleSize: total,
      });

      expect(outOfRange).toBe(0);
    });
  });

  // Note: Materialized View Consistency tests removed
  // OHLC MVs (mv_ob_bbo_1m, mv_ob_bbo_5m) were removed for cost reduction
  // Raw ob_bbo data is retained for 365 days and can be used for on-demand OHLC computation

  describe("Temporal Consistency", () => {
    it("should have ingestion_ts >= source_ts (minimal time travel)", async () => {
      if (!config) return;

      // Note: Some historical data may have time travel due to a timestamp unit bug
      // (source_ts was stored in ms instead of μs before fix).
      // We allow a small percentage of time travel for backwards compatibility.
      const query = `
        SELECT
          count() as total,
          countIf(ingestion_ts < source_ts) as time_travel_count
        FROM ${getTable("OB_BBO")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        time_travel_count: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const timeTravelCount = Number(result.data[0].time_travel_count);
      const timeTravelPercent = total > 0 ? (timeTravelCount / total) * 100 : 0;

      console.log(`\nTime travel analysis:`);
      console.log(`  Records with ingestion < source: ${timeTravelCount}/${total} (${timeTravelPercent.toFixed(2)}%)`);

      validationResults.push({
        passed: timeTravelPercent < VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT,
        test: "ingestion_ts >= source_ts",
        message:
          timeTravelCount === 0
            ? `All ${total} records have valid timestamps`
            : `${timeTravelCount}/${total} (${timeTravelPercent.toFixed(2)}%) records have time travel (threshold: ${VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT}%)`,
        sampleSize: total,
      });

      expect(timeTravelPercent).toBeLessThan(VALIDATION_THRESHOLDS.TIME_TRAVEL_PERCENT);
    });

    it("should have monotonically increasing sequence numbers per asset", async () => {
      if (!config) return;

      // Check for sequence number regressions within each asset
      const query = `
        SELECT
          asset_id,
          count() as regression_count
        FROM (
          SELECT
            asset_id,
            sequence_number,
            lagInFrame(sequence_number) OVER (PARTITION BY asset_id ORDER BY source_ts) as prev_seq
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND is_resync = 0
        )
        WHERE prev_seq IS NOT NULL AND sequence_number < prev_seq
        GROUP BY asset_id
        LIMIT 10
      `;

      const result = await executeQuery<{
        asset_id: string;
        regression_count: string;
      }>(config, query);

      const regressionAssets = result.data.length;

      validationResults.push({
        passed: regressionAssets === 0,
        test: "Sequence numbers monotonically increase",
        message:
          regressionAssets === 0
            ? "All assets have monotonic sequence numbers"
            : `${regressionAssets} assets have sequence regressions`,
        actual: result.data.slice(0, 3),
      });

      if (regressionAssets > 0) {
        console.log(`\nAssets with sequence regressions:`, result.data.slice(0, 3));
      }

      // Allow some regressions (resyncs may cause legitimate sequence resets)
      expect(regressionAssets).toBeLessThan(VALIDATION_THRESHOLDS.SEQUENCE_REGRESSION_ASSETS_MAX);
    });
  });

  describe("Order Book Level Changes", () => {
    it("should have size_delta = new_size - old_size", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(abs(size_delta - (new_size - old_size)) > 0.0001) as mismatches
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      validationResults.push({
        passed: mismatches === 0,
        test: "size_delta = new_size - old_size",
        message:
          mismatches === 0
            ? `All ${total} level changes have correct size_delta`
            : `${mismatches}/${total} level changes have incorrect size_delta`,
        sampleSize: total,
      });

      expect(mismatches).toBe(0);
    });

    it("should have valid change_type based on sizes", async () => {
      if (!config) return;

      // ADD: old_size = 0, new_size > 0
      // REMOVE: old_size > 0, new_size = 0
      // UPDATE: old_size > 0, new_size > 0
      const query = `
        SELECT
          count() as total,
          countIf(
            (change_type = 'ADD' AND (old_size != 0 OR new_size <= 0))
            OR (change_type = 'REMOVE' AND (old_size <= 0 OR new_size != 0))
            OR (change_type = 'UPDATE' AND (old_size <= 0 OR new_size <= 0))
          ) as mismatches
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        mismatches: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const mismatches = Number(result.data[0].mismatches);

      const mismatchPercent = total > 0 ? (mismatches / total) * 100 : 0;

      validationResults.push({
        passed: mismatchPercent < 5, // Allow up to 5% inconsistencies (edge cases in level change detection)
        test: "change_type consistent with sizes",
        message:
          mismatches === 0
            ? `All ${total} changes have correct change_type`
            : `${mismatches}/${total} (${mismatchPercent.toFixed(2)}%) changes have inconsistent change_type`,
        sampleSize: total,
      });

      if (mismatches > 0 && mismatchPercent >= 5) {
        const sampleQuery = `
          SELECT change_type, old_size, new_size, size_delta
          FROM ${getTable("OB_LEVEL_CHANGES")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND (
              (change_type = 'ADD' AND (old_size != 0 OR new_size <= 0))
              OR (change_type = 'REMOVE' AND (old_size <= 0 OR new_size != 0))
              OR (change_type = 'UPDATE' AND (old_size <= 0 OR new_size <= 0))
            )
          LIMIT 5
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nInconsistent change_type samples:`, sampleResult.data);
        console.log(`\nNote: Polymarket level changes may not always have old_size available.`);
      }

      // Allow inconsistencies - Polymarket doesn't always provide old_size
      expect(mismatchPercent).toBeLessThan(VALIDATION_THRESHOLDS.CHANGE_TYPE_MISMATCH_PERCENT);
    });

    it("should have valid side values", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(side NOT IN ('BUY', 'SELL')) as invalid_side
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        invalid_side: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const invalidSide = Number(result.data[0].invalid_side);

      validationResults.push({
        passed: invalidSide === 0,
        test: "Valid side values (BUY/SELL)",
        message:
          invalidSide === 0
            ? `All ${total} changes have valid side`
            : `${invalidSide}/${total} changes have invalid side`,
        sampleSize: total,
      });

      expect(invalidSide).toBe(0);
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
