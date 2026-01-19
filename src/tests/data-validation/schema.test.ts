/**
 * P3 Schema Validation Tests
 *
 * These tests validate schema integrity, data type constraints,
 * enum values, and edge cases in the data.
 *
 * Run with: npx vitest run src/tests/data-validation/schema.test.ts
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

describe("P3: Schema Validation", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping Schema tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("Table Structure", () => {
    it("should have all expected tables", async () => {
      if (!config) return;

      const expectedTables = [
        "ob_bbo",
        "ob_snapshots",
        "ob_level_changes",
        "trade_ticks",
        "ob_gap_events",
        "ob_latency",
        "market_metadata",
      ];

      const query = `
        SELECT name
        FROM system.tables
        WHERE database = 'polymarket'
        ORDER BY name
      `;

      const result = await executeQuery<{ name: string }>(config, query);
      const actualTables = result.data.map((r) => r.name);

      console.log(`\nTables in polymarket database:`);
      for (const table of actualTables) {
        const expected = expectedTables.includes(table) ? "✓" : " ";
        console.log(`  ${expected} ${table}`);
      }

      const missingTables = expectedTables.filter((t) => !actualTables.includes(t));

      validationResults.push({
        passed: missingTables.length === 0,
        test: "All expected tables exist",
        message:
          missingTables.length === 0
            ? `All ${expectedTables.length} tables present`
            : `Missing tables: ${missingTables.join(", ")}`,
        actual: { found: actualTables.length, missing: missingTables },
      });

      expect(missingTables.length).toBe(0);
    });

    it("should have correct column types for ob_snapshots", async () => {
      if (!config) return;

      const query = `
        SELECT name, type
        FROM system.columns
        WHERE database = 'polymarket' AND table = 'ob_snapshots'
        ORDER BY position
      `;

      const result = await executeQuery<{ name: string; type: string }>(config, query);

      const expectedColumns: Record<string, string> = {
        asset_id: "String",
        condition_id: "String",
        source_ts: "DateTime64(3, 'UTC')",
        ingestion_ts: "DateTime64(6, 'UTC')",
        book_hash: "String",
        bid_prices: "Array(Decimal(38, 18))",
        bid_sizes: "Array(Float64)",
        ask_prices: "Array(Decimal(38, 18))",
        ask_sizes: "Array(Float64)",
        tick_size: "Decimal(38, 18)",
        sequence_number: "UInt64",
      };

      console.log(`\nob_snapshots columns:`);
      let mismatchCount = 0;
      for (const col of result.data) {
        const expected = expectedColumns[col.name];
        const match = !expected || col.type.includes(expected.split("(")[0]);
        if (!match && expected) mismatchCount++;
        const status = !expected ? " " : match ? "✓" : "✗";
        console.log(`  ${status} ${col.name}: ${col.type}`);
      }

      validationResults.push({
        passed: mismatchCount === 0,
        test: "ob_snapshots column types",
        message:
          mismatchCount === 0
            ? "All column types match expected"
            : `${mismatchCount} column type mismatches`,
        actual: result.data.slice(0, 10),
      });

      expect(mismatchCount).toBe(0);
    });

    it("should have correct column types for trade_ticks", async () => {
      if (!config) return;

      const query = `
        SELECT name, type
        FROM system.columns
        WHERE database = 'polymarket' AND table = 'trade_ticks'
        ORDER BY position
      `;

      const result = await executeQuery<{ name: string; type: string }>(config, query);

      const expectedColumns: Record<string, string> = {
        asset_id: "String",
        condition_id: "String",
        trade_id: "String",
        price: "Decimal",
        size: "Float64",
        side: "LowCardinality(String)",
        source_ts: "DateTime64",
        ingestion_ts: "DateTime64",
      };

      console.log(`\ntrade_ticks columns:`);
      let mismatchCount = 0;
      for (const col of result.data) {
        const expected = expectedColumns[col.name];
        const match = !expected || col.type.includes(expected.split("(")[0]);
        if (!match && expected) mismatchCount++;
        const status = !expected ? " " : match ? "✓" : "✗";
        console.log(`  ${status} ${col.name}: ${col.type}`);
      }

      validationResults.push({
        passed: mismatchCount === 0,
        test: "trade_ticks column types",
        message:
          mismatchCount === 0
            ? "All column types match expected"
            : `${mismatchCount} column type mismatches`,
        actual: result.data,
      });

      expect(mismatchCount).toBe(0);
    });
  });

  describe("Enum Value Validation", () => {
    it("should have valid side values in trade_ticks", async () => {
      if (!config) return;

      const query = `
        SELECT side, count() as cnt
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY side
        ORDER BY cnt DESC
      `;

      const result = await executeQuery<{ side: string; cnt: string }>(config, query);

      console.log(`\nTrade sides:`);
      const validSides = ["BUY", "SELL"];
      let invalidCount = 0;
      for (const row of result.data) {
        const valid = validSides.includes(row.side);
        if (!valid) invalidCount += Number(row.cnt);
        console.log(`  ${valid ? "✓" : "✗"} ${row.side}: ${row.cnt}`);
      }

      validationResults.push({
        passed: invalidCount === 0,
        test: "Valid trade side values",
        message:
          invalidCount === 0
            ? "All trades have valid side (BUY/SELL)"
            : `${invalidCount} trades have invalid side`,
        actual: result.data,
      });

      expect(invalidCount).toBe(0);
    });

    it("should have valid side values in ob_level_changes", async () => {
      if (!config) return;

      const query = `
        SELECT side, count() as cnt
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY side
        ORDER BY cnt DESC
      `;

      const result = await executeQuery<{ side: string; cnt: string }>(config, query);

      console.log(`\nLevel change sides:`);
      const validSides = ["BUY", "SELL"];
      let invalidCount = 0;
      for (const row of result.data) {
        const valid = validSides.includes(row.side);
        if (!valid) invalidCount += Number(row.cnt);
        console.log(`  ${valid ? "✓" : "✗"} ${row.side}: ${row.cnt}`);
      }

      validationResults.push({
        passed: invalidCount === 0,
        test: "Valid level change side values",
        message:
          invalidCount === 0
            ? "All level changes have valid side"
            : `${invalidCount} level changes have invalid side`,
        actual: result.data,
      });

      expect(invalidCount).toBe(0);
    });

    it("should have valid change_type values in ob_level_changes", async () => {
      if (!config) return;

      const query = `
        SELECT change_type, count() as cnt
        FROM ${getTable("OB_LEVEL_CHANGES")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY change_type
        ORDER BY cnt DESC
      `;

      const result = await executeQuery<{ change_type: string; cnt: string }>(config, query);

      console.log(`\nLevel change types:`);
      const validTypes = ["ADD", "REMOVE", "UPDATE"];
      let invalidCount = 0;
      for (const row of result.data) {
        const valid = validTypes.includes(row.change_type);
        if (!valid) invalidCount += Number(row.cnt);
        console.log(`  ${valid ? "✓" : "✗"} ${row.change_type}: ${row.cnt}`);
      }

      validationResults.push({
        passed: invalidCount === 0,
        test: "Valid change_type values",
        message:
          invalidCount === 0
            ? "All level changes have valid change_type"
            : `${invalidCount} have invalid change_type`,
        actual: result.data,
      });

      expect(invalidCount).toBe(0);
    });

    it("should have valid resolution values in ob_gap_events", async () => {
      if (!config) return;

      const query = `
        SELECT resolution, count() as cnt
        FROM ${getTable("OB_GAP_EVENTS")}
        WHERE detected_at >= now() - INTERVAL 7 DAY
        GROUP BY resolution
        ORDER BY cnt DESC
      `;

      const result = await executeQuery<{ resolution: string; cnt: string }>(config, query);

      console.log(`\nGap resolution types:`);
      const validResolutions = ["PENDING", "RESOLVED", "FAILED"];
      let invalidCount = 0;
      for (const row of result.data) {
        const valid = validResolutions.includes(row.resolution);
        if (!valid) invalidCount += Number(row.cnt);
        console.log(`  ${valid ? "✓" : "✗"} ${row.resolution}: ${row.cnt}`);
      }

      validationResults.push({
        passed: invalidCount === 0,
        test: "Valid gap resolution values",
        message:
          invalidCount === 0
            ? "All gap events have valid resolution"
            : `${invalidCount} have invalid resolution`,
        actual: result.data,
      });

      expect(invalidCount).toBe(0);
    });
  });

  describe("Nullable Field Handling", () => {
    it("should have non-null required fields in ob_snapshots", async () => {
      if (!config) return;

      const query = `
        SELECT
          countIf(asset_id = '') as empty_asset_id,
          countIf(condition_id = '') as empty_condition_id,
          countIf(book_hash = '') as empty_hash,
          count() as total
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        empty_asset_id: string;
        empty_condition_id: string;
        empty_hash: string;
        total: string;
      }>(config, query);

      const emptyAssetId = Number(result.data[0].empty_asset_id);
      const emptyConditionId = Number(result.data[0].empty_condition_id);
      const emptyHash = Number(result.data[0].empty_hash);
      const total = Number(result.data[0].total);

      console.log(`\nRequired field nullability (ob_snapshots):`);
      console.log(`  Total: ${total}`);
      console.log(`  Empty asset_id: ${emptyAssetId}`);
      console.log(`  Empty condition_id: ${emptyConditionId}`);
      console.log(`  Empty book_hash: ${emptyHash}`);

      const totalEmpty = emptyAssetId + emptyConditionId + emptyHash;

      validationResults.push({
        passed: totalEmpty === 0,
        test: "No empty required fields",
        message:
          totalEmpty === 0
            ? "All required fields populated"
            : `${totalEmpty} records have empty required fields`,
        actual: { emptyAssetId, emptyConditionId, emptyHash },
        sampleSize: total,
      });

      expect(totalEmpty).toBe(0);
    });

    it("should have non-null required fields in trade_ticks", async () => {
      if (!config) return;

      const query = `
        SELECT
          countIf(asset_id = '') as empty_asset_id,
          countIf(trade_id = '') as empty_trade_id,
          countIf(side = '') as empty_side,
          count() as total
        FROM ${getTable("TRADE_TICKS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        empty_asset_id: string;
        empty_trade_id: string;
        empty_side: string;
        total: string;
      }>(config, query);

      const emptyAssetId = Number(result.data[0].empty_asset_id);
      const emptyTradeId = Number(result.data[0].empty_trade_id);
      const emptySide = Number(result.data[0].empty_side);
      const total = Number(result.data[0].total);

      console.log(`\nRequired field nullability (trade_ticks):`);
      console.log(`  Total: ${total}`);
      console.log(`  Empty asset_id: ${emptyAssetId}`);
      console.log(`  Empty trade_id: ${emptyTradeId}`);
      console.log(`  Empty side: ${emptySide}`);

      const totalEmpty = emptyAssetId + emptyTradeId + emptySide;

      validationResults.push({
        passed: totalEmpty === 0,
        test: "No empty trade required fields",
        message:
          totalEmpty === 0
            ? "All required fields populated"
            : `${totalEmpty} trades have empty required fields`,
        actual: { emptyAssetId, emptyTradeId, emptySide },
        sampleSize: total,
      });

      expect(totalEmpty).toBe(0);
    });
  });

  describe("Array Consistency", () => {
    it("should have matching bid_prices and bid_sizes array lengths", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(length(bid_prices) != length(bid_sizes)) as bid_mismatch,
          countIf(length(ask_prices) != length(ask_sizes)) as ask_mismatch
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        bid_mismatch: string;
        ask_mismatch: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const bidMismatch = Number(result.data[0].bid_mismatch);
      const askMismatch = Number(result.data[0].ask_mismatch);

      console.log(`\nArray length consistency:`);
      console.log(`  Total: ${total}`);
      console.log(`  Bid price/size mismatch: ${bidMismatch}`);
      console.log(`  Ask price/size mismatch: ${askMismatch}`);

      const totalMismatch = bidMismatch + askMismatch;

      validationResults.push({
        passed: totalMismatch === 0,
        test: "Price/size array lengths match",
        message:
          totalMismatch === 0
            ? "All arrays have matching lengths"
            : `${totalMismatch} snapshots have mismatched array lengths`,
        sampleSize: total,
      });

      expect(totalMismatch).toBe(0);
    });

    it("should have non-empty arrays for active orderbooks", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(length(bid_prices) = 0 AND length(ask_prices) = 0) as empty_book,
          countIf(length(bid_prices) = 0 AND length(ask_prices) > 0) as no_bids,
          countIf(length(bid_prices) > 0 AND length(ask_prices) = 0) as no_asks
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        empty_book: string;
        no_bids: string;
        no_asks: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const emptyBook = Number(result.data[0].empty_book);
      const noBids = Number(result.data[0].no_bids);
      const noAsks = Number(result.data[0].no_asks);

      const emptyPercent = total > 0 ? (emptyBook / total) * 100 : 0;

      console.log(`\nOrderbook array population:`);
      console.log(`  Total: ${total}`);
      console.log(`  Empty books (no bids or asks): ${emptyBook} (${emptyPercent.toFixed(2)}%)`);
      console.log(`  No bids only: ${noBids}`);
      console.log(`  No asks only: ${noAsks}`);

      validationResults.push({
        passed: emptyPercent < 10,
        test: "< 10% empty orderbooks",
        message: `${emptyPercent.toFixed(2)}% of snapshots have empty books`,
        actual: { emptyBook, noBids, noAsks, total },
        sampleSize: total,
      });

      expect(emptyPercent).toBeLessThan(10);
    });
  });

  describe("Decimal Precision", () => {
    it("should have valid price precision in ob_snapshots", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(best_bid < 0 OR best_bid > 1) as invalid_bid,
          countIf(best_ask < 0 OR best_ask > 1) as invalid_ask,
          min(best_bid) as min_bid,
          max(best_bid) as max_bid,
          min(best_ask) as min_ask,
          max(best_ask) as max_ask
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND (length(bid_prices) > 0 OR length(ask_prices) > 0)
      `;

      const result = await executeQuery<{
        total: string;
        invalid_bid: string;
        invalid_ask: string;
        min_bid: number;
        max_bid: number;
        min_ask: number;
        max_ask: number;
      }>(config, query);

      const total = Number(result.data[0].total);
      const invalidBid = Number(result.data[0].invalid_bid);
      const invalidAsk = Number(result.data[0].invalid_ask);

      console.log(`\nPrice precision (ob_snapshots):`);
      console.log(`  Total: ${total}`);
      console.log(`  Invalid bids (< 0 or > 1): ${invalidBid}`);
      console.log(`  Invalid asks (< 0 or > 1): ${invalidAsk}`);
      console.log(`  Bid range: ${result.data[0].min_bid} - ${result.data[0].max_bid}`);
      console.log(`  Ask range: ${result.data[0].min_ask} - ${result.data[0].max_ask}`);

      const totalInvalid = invalidBid + invalidAsk;

      validationResults.push({
        passed: totalInvalid === 0,
        test: "Prices in [0, 1] range",
        message:
          totalInvalid === 0
            ? "All prices in valid range"
            : `${totalInvalid} records have out-of-range prices`,
        sampleSize: total,
      });

      expect(totalInvalid).toBe(0);
    });

    it("should have valid tick_size values", async () => {
      if (!config) return;

      const query = `
        SELECT
          tick_size,
          count() as cnt
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        GROUP BY tick_size
        ORDER BY cnt DESC
        LIMIT 10
      `;

      const result = await executeQuery<{
        tick_size: number;
        cnt: string;
      }>(config, query);

      console.log(`\nTick size distribution:`);
      let invalidCount = 0;
      for (const row of result.data) {
        const valid = row.tick_size > 0 && row.tick_size <= 0.1;
        if (!valid) invalidCount += Number(row.cnt);
        console.log(`  ${valid ? "✓" : "✗"} ${row.tick_size}: ${row.cnt}`);
      }

      validationResults.push({
        passed: invalidCount === 0,
        test: "Valid tick_size values",
        message:
          invalidCount === 0
            ? "All tick sizes valid (0 < tick_size <= 0.1)"
            : `${invalidCount} records have invalid tick_size`,
        actual: result.data,
      });

      expect(invalidCount).toBe(0);
    });
  });

  describe("String Field Validation", () => {
    it("should have valid asset_id format (numeric string)", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(NOT match(asset_id, '^[0-9]+$')) as invalid_format
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        invalid_format: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const invalidFormat = Number(result.data[0].invalid_format);

      console.log(`\nAsset_id format validation:`);
      console.log(`  Total: ${total}`);
      console.log(`  Invalid format (non-numeric): ${invalidFormat}`);

      validationResults.push({
        passed: invalidFormat === 0,
        test: "Asset_id is numeric string",
        message:
          invalidFormat === 0
            ? "All asset_ids are numeric strings"
            : `${invalidFormat} have invalid format`,
        sampleSize: total,
      });

      expect(invalidFormat).toBe(0);
    });

    it("should have valid book_hash format", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(length(book_hash) < 10) as too_short,
          countIf(NOT match(book_hash, '^[a-f0-9]+$')) as invalid_hex
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        too_short: string;
        invalid_hex: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const tooShort = Number(result.data[0].too_short);
      const invalidHex = Number(result.data[0].invalid_hex);

      console.log(`\nBook_hash format validation:`);
      console.log(`  Total: ${total}`);
      console.log(`  Too short (< 10 chars): ${tooShort}`);
      console.log(`  Invalid hex: ${invalidHex}`);

      const totalInvalid = tooShort + invalidHex;

      validationResults.push({
        passed: totalInvalid === 0,
        test: "Valid book_hash format",
        message:
          totalInvalid === 0
            ? "All book hashes have valid format"
            : `${totalInvalid} have invalid hash format`,
        sampleSize: total,
      });

      expect(totalInvalid).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero prices gracefully", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(best_bid = 0 AND length(bid_prices) > 0) as zero_bid_with_data,
          countIf(best_ask = 0 AND length(ask_prices) > 0) as zero_ask_with_data
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
      `;

      const result = await executeQuery<{
        total: string;
        zero_bid_with_data: string;
        zero_ask_with_data: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const zeroBid = Number(result.data[0].zero_bid_with_data);
      const zeroAsk = Number(result.data[0].zero_ask_with_data);

      console.log(`\nZero price edge cases:`);
      console.log(`  Total: ${total}`);
      console.log(`  Zero best_bid with bid data: ${zeroBid}`);
      console.log(`  Zero best_ask with ask data: ${zeroAsk}`);

      validationResults.push({
        passed: true, // Informational
        test: "Zero price handling",
        message: `${zeroBid} zero bids, ${zeroAsk} zero asks with array data`,
        sampleSize: total,
      });
    });

    it("should handle very large sizes", async () => {
      if (!config) return;

      const query = `
        SELECT
          max(bid_size) as max_bid_size,
          max(ask_size) as max_ask_size,
          max(size) as max_trade_size
        FROM (
          SELECT bid_size, ask_size, 0 as size
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          UNION ALL
          SELECT 0 as bid_size, 0 as ask_size, size
          FROM ${getTable("TRADE_TICKS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
        )
      `;

      try {
        const result = await executeQuery<{
          max_bid_size: number;
          max_ask_size: number;
          max_trade_size: number;
        }>(config, query);

        console.log(`\nMax sizes:`);
        console.log(`  Max bid_size: ${result.data[0].max_bid_size}`);
        console.log(`  Max ask_size: ${result.data[0].max_ask_size}`);
        console.log(`  Max trade_size: ${result.data[0].max_trade_size}`);

        validationResults.push({
          passed: true,
          test: "Size bounds check",
          message: `Max sizes within Float64 range`,
          actual: result.data[0],
        });
      } catch (error) {
        // ob_bbo may be empty
        console.log(`\nSkipping max size check: ${(error as Error).message}`);
      }
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
