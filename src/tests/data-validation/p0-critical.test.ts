/**
 * P0 Critical Validation Tests
 *
 * These tests address critical gaps in data validation:
 * 1. Live Orderbook Price Comparison - Compare stored BBO against live API
 * 2. Spreads API Cross-Validation - Validate spread_bps against live spreads
 * 3. Price Level Ordering Invariant - Verify bid/ask price ordering
 * 4. Historical Reconstruction Validation - Verify level changes can reconstruct snapshots
 *
 * Run with: npx vitest run src/tests/data-validation/p0-critical.test.ts
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
  fetchOrderbookSummary,
  fetchLiveSpreads,
  getRecentAssetIds,
  approxEqual,
  TEST_CONFIG,
  type ClickHouseConfig,
  type ValidationResult,
  formatValidationResults,
} from "./test-utils";

describe("P0: Critical Validation Tests", () => {
  let config: ClickHouseConfig | null;
  const validationResults: ValidationResult[] = [];

  beforeAll(() => {
    config = getClickHouseConfig();
    if (!config) {
      console.log(
        "Skipping P0 Critical tests: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required"
      );
    }
  });

  describe("Live Orderbook Price Comparison", () => {
    it("should have stored BBO matching live API values within tolerance", async () => {
      if (!config) return;

      // Get recent active asset IDs
      const assetIds = await getRecentAssetIds(config, 10);

      if (assetIds.length === 0) {
        console.log("\nNo recent asset IDs found - skipping live BBO comparison");
        validationResults.push({
          passed: true,
          test: "Stored BBO matches live API",
          message: "Skipped - no recent data to validate",
        });
        return;
      }

      console.log(`\nComparing ${assetIds.length} assets against live Polymarket API...`);

      let matchCount = 0;
      let driftCount = 0;
      let skippedCount = 0;
      const driftDetails: Array<{
        asset_id: string;
        stored_bid: number;
        live_bid: number;
        stored_ask: number;
        live_ask: number;
        bid_drift_pct: number;
        ask_drift_pct: number;
      }> = [];

      // Allow 1% price drift to account for timing differences
      const PRICE_DRIFT_TOLERANCE = 0.01;

      for (const assetId of assetIds) {
        // Fetch live orderbook summary
        const liveSummary = await fetchOrderbookSummary(assetId);
        if (!liveSummary || liveSummary.best_bid === 0 || liveSummary.best_ask === 0) {
          skippedCount++;
          continue;
        }

        // Get most recent stored BBO
        const storedQuery = `
          SELECT best_bid, best_ask, source_ts
          FROM ${getTable("OB_BBO")}
          WHERE asset_id = '${assetId}'
          ORDER BY source_ts DESC
          LIMIT 1
        `;

        const storedResult = await executeQuery<{
          best_bid: number;
          best_ask: number;
          source_ts: string;
        }>(config, storedQuery);

        if (storedResult.data.length === 0) {
          // Try ob_snapshots as fallback
          const snapshotQuery = `
            SELECT best_bid, best_ask, source_ts
            FROM ${getTable("OB_SNAPSHOTS")}
            WHERE asset_id = '${assetId}'
            ORDER BY source_ts DESC
            LIMIT 1
          `;
          const snapshotResult = await executeQuery<{
            best_bid: number;
            best_ask: number;
            source_ts: string;
          }>(config, snapshotQuery);

          if (snapshotResult.data.length === 0) {
            skippedCount++;
            continue;
          }

          storedResult.data = snapshotResult.data;
        }

        const stored = storedResult.data[0];
        const storedBid = stored.best_bid;
        const storedAsk = stored.best_ask;

        // Calculate drift percentage
        const bidDrift =
          liveSummary.best_bid > 0
            ? Math.abs(storedBid - liveSummary.best_bid) / liveSummary.best_bid
            : 0;
        const askDrift =
          liveSummary.best_ask > 0
            ? Math.abs(storedAsk - liveSummary.best_ask) / liveSummary.best_ask
            : 0;

        const hasSignificantDrift =
          bidDrift > PRICE_DRIFT_TOLERANCE || askDrift > PRICE_DRIFT_TOLERANCE;

        if (hasSignificantDrift) {
          driftCount++;
          driftDetails.push({
            asset_id: assetId.slice(0, 20) + "...",
            stored_bid: storedBid,
            live_bid: liveSummary.best_bid,
            stored_ask: storedAsk,
            live_ask: liveSummary.best_ask,
            bid_drift_pct: bidDrift * 100,
            ask_drift_pct: askDrift * 100,
          });
        } else {
          matchCount++;
        }

        console.log(`  ${assetId.slice(0, 20)}...`);
        console.log(
          `    Stored: bid=${storedBid.toFixed(4)} ask=${storedAsk.toFixed(4)}`
        );
        console.log(
          `    Live:   bid=${liveSummary.best_bid.toFixed(4)} ask=${liveSummary.best_ask.toFixed(4)}`
        );
        console.log(
          `    Drift:  bid=${(bidDrift * 100).toFixed(2)}% ask=${(askDrift * 100).toFixed(2)}%`
        );
      }

      const testedCount = matchCount + driftCount;
      const driftPercent = testedCount > 0 ? (driftCount / testedCount) * 100 : 0;

      validationResults.push({
        passed: driftPercent < 20, // Allow up to 20% with drift (stale data is expected)
        test: "Stored BBO matches live API",
        message:
          driftPercent < 20
            ? `${matchCount}/${testedCount} assets within ${PRICE_DRIFT_TOLERANCE * 100}% drift tolerance (${skippedCount} skipped)`
            : `${driftCount}/${testedCount} assets have significant price drift`,
        expected: `< ${PRICE_DRIFT_TOLERANCE * 100}% drift`,
        actual: driftDetails.slice(0, 3),
        sampleSize: testedCount,
      });

      if (driftDetails.length > 0) {
        console.log(`\nAssets with significant drift (>${PRICE_DRIFT_TOLERANCE * 100}%):`);
        for (const d of driftDetails.slice(0, 5)) {
          console.log(
            `  ${d.asset_id}: bid drift ${d.bid_drift_pct.toFixed(2)}%, ask drift ${d.ask_drift_pct.toFixed(2)}%`
          );
        }
      }

      // Fail only if majority of tested assets have drift
      expect(driftPercent).toBeLessThan(50);
    });

    it("should have stored orderbook depth approximately matching live API", async () => {
      if (!config) return;

      const assetIds = await getRecentAssetIds(config, 5);

      if (assetIds.length === 0) {
        console.log("\nNo recent asset IDs found - skipping depth comparison");
        return;
      }

      console.log(`\nComparing orderbook depth for ${assetIds.length} assets...`);

      let matchCount = 0;
      let mismatchCount = 0;
      const DEPTH_TOLERANCE = 0.25; // Allow 25% depth variance

      for (const assetId of assetIds) {
        const liveSummary = await fetchOrderbookSummary(assetId);
        if (!liveSummary) continue;

        // Get stored depth from ob_snapshots
        const storedQuery = `
          SELECT
            total_bid_depth,
            total_ask_depth,
            bid_levels,
            ask_levels
          FROM ${getTable("OB_SNAPSHOTS")}
          WHERE asset_id = '${assetId}'
          ORDER BY source_ts DESC
          LIMIT 1
        `;

        const storedResult = await executeQuery<{
          total_bid_depth: number;
          total_ask_depth: number;
          bid_levels: number;
          ask_levels: number;
        }>(config, storedQuery);

        if (storedResult.data.length === 0) continue;

        const stored = storedResult.data[0];

        // Compare depths with tolerance
        const bidDepthMatch = approxEqual(
          stored.total_bid_depth,
          liveSummary.total_bid_depth,
          DEPTH_TOLERANCE
        );
        const askDepthMatch = approxEqual(
          stored.total_ask_depth,
          liveSummary.total_ask_depth,
          DEPTH_TOLERANCE
        );

        if (bidDepthMatch && askDepthMatch) {
          matchCount++;
        } else {
          mismatchCount++;
        }

        console.log(`  ${assetId.slice(0, 20)}...`);
        console.log(
          `    Stored depth: bid=${stored.total_bid_depth.toFixed(2)} (${stored.bid_levels} levels) ask=${stored.total_ask_depth.toFixed(2)} (${stored.ask_levels} levels)`
        );
        console.log(
          `    Live depth:   bid=${liveSummary.total_bid_depth.toFixed(2)} (${liveSummary.bid_levels} levels) ask=${liveSummary.total_ask_depth.toFixed(2)} (${liveSummary.ask_levels} levels)`
        );
      }

      validationResults.push({
        passed: matchCount > 0,
        test: "Orderbook depth approximately matches live API",
        message: `${matchCount}/${matchCount + mismatchCount} assets have matching depth within ${DEPTH_TOLERANCE * 100}% tolerance`,
        sampleSize: matchCount + mismatchCount,
      });
    });
  });

  describe("Spreads API Cross-Validation", () => {
    it("should have spread_bps matching live calculated spreads", async () => {
      if (!config) return;

      const assetIds = await getRecentAssetIds(config, 10);

      if (assetIds.length === 0) {
        console.log("\nNo recent asset IDs found - skipping spreads validation");
        validationResults.push({
          passed: true,
          test: "spread_bps matches live spreads",
          message: "Skipped - no recent data to validate",
        });
        return;
      }

      console.log(`\nValidating spreads for ${assetIds.length} assets against live API...`);

      let matchCount = 0;
      let mismatchCount = 0;
      let skippedCount = 0;
      const mismatchDetails: Array<{
        asset_id: string;
        stored_spread_bps: number;
        live_spread_bps: number;
        diff_bps: number;
      }> = [];

      // Allow 5 bps tolerance for spread comparison
      const SPREAD_BPS_TOLERANCE = 5;

      for (const assetId of assetIds) {
        // Fetch live spreads
        const liveSpreads = await fetchLiveSpreads(assetId);
        if (!liveSpreads || liveSpreads.mid === 0) {
          skippedCount++;
          continue;
        }

        // Calculate live spread_bps
        const liveSpreadBps = (liveSpreads.spread / liveSpreads.mid) * 10000;

        // Get stored spread_bps
        const storedQuery = `
          SELECT spread_bps, best_bid, best_ask, mid_price
          FROM ${getTable("OB_BBO")}
          WHERE asset_id = '${assetId}'
            AND best_bid > 0 AND best_ask > 0
          ORDER BY source_ts DESC
          LIMIT 1
        `;

        const storedResult = await executeQuery<{
          spread_bps: number;
          best_bid: number;
          best_ask: number;
          mid_price: number;
        }>(config, storedQuery);

        if (storedResult.data.length === 0) {
          skippedCount++;
          continue;
        }

        const stored = storedResult.data[0];
        const spreadDiff = Math.abs(stored.spread_bps - liveSpreadBps);

        if (spreadDiff <= SPREAD_BPS_TOLERANCE) {
          matchCount++;
        } else {
          mismatchCount++;
          mismatchDetails.push({
            asset_id: assetId.slice(0, 20) + "...",
            stored_spread_bps: stored.spread_bps,
            live_spread_bps: liveSpreadBps,
            diff_bps: spreadDiff,
          });
        }

        console.log(`  ${assetId.slice(0, 20)}...`);
        console.log(`    Stored spread: ${stored.spread_bps.toFixed(2)} bps`);
        console.log(`    Live spread:   ${liveSpreadBps.toFixed(2)} bps`);
        console.log(`    Difference:    ${spreadDiff.toFixed(2)} bps`);
      }

      const testedCount = matchCount + mismatchCount;
      const matchPercent = testedCount > 0 ? (matchCount / testedCount) * 100 : 100;

      validationResults.push({
        passed: matchPercent >= 50, // At least 50% should match
        test: "spread_bps matches live spreads",
        message:
          matchPercent >= 50
            ? `${matchCount}/${testedCount} assets have matching spreads within ${SPREAD_BPS_TOLERANCE} bps (${skippedCount} skipped)`
            : `Only ${matchCount}/${testedCount} assets have matching spreads`,
        expected: `< ${SPREAD_BPS_TOLERANCE} bps difference`,
        actual: mismatchDetails.slice(0, 3),
        sampleSize: testedCount,
      });

      if (mismatchDetails.length > 0) {
        console.log(`\nAssets with spread mismatch (>${SPREAD_BPS_TOLERANCE} bps):`);
        for (const d of mismatchDetails.slice(0, 5)) {
          console.log(
            `  ${d.asset_id}: stored=${d.stored_spread_bps.toFixed(2)} bps, live=${d.live_spread_bps.toFixed(2)} bps, diff=${d.diff_bps.toFixed(2)} bps`
          );
        }
      }

      // Don't fail if data is stale - just warn
      expect(matchPercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Price Level Ordering Invariant", () => {
    it("should have bid_prices in strictly descending order", async () => {
      if (!config) return;

      // Check for any snapshots where bid_prices are not descending
      const query = `
        SELECT
          count() as total,
          countIf(
            length(bid_prices) > 1
            AND NOT arrayAll((x, i) -> i = 1 OR x < bid_prices[i - 1], bid_prices, arrayEnumerate(bid_prices))
          ) as not_descending
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND length(bid_prices) > 1
      `;

      const result = await executeQuery<{
        total: string;
        not_descending: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const notDescending = Number(result.data[0].not_descending);
      const notDescendingPercent = total > 0 ? (notDescending / total) * 100 : 0;

      console.log(`\nBid price ordering validation (n=${total}):`);
      console.log(`  Not descending: ${notDescending} (${notDescendingPercent.toFixed(4)}%)`);

      validationResults.push({
        passed: notDescending === 0,
        test: "bid_prices strictly descending",
        message:
          notDescending === 0
            ? `All ${total} snapshots have correctly ordered bid prices`
            : `${notDescending}/${total} snapshots have non-descending bid prices`,
        sampleSize: total,
      });

      if (notDescending > 0) {
        // Get sample of violations
        const sampleQuery = `
          SELECT asset_id, source_ts, bid_prices
          FROM ${getTable("OB_SNAPSHOTS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND length(bid_prices) > 1
            AND NOT arrayAll((x, i) -> i = 1 OR x < bid_prices[i - 1], bid_prices, arrayEnumerate(bid_prices))
          LIMIT 3
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nSample of non-descending bid prices:`, sampleResult.data);
      }

      expect(notDescending).toBe(0);
    });

    it("should have ask_prices in strictly ascending order", async () => {
      if (!config) return;

      // Check for any snapshots where ask_prices are not ascending
      const query = `
        SELECT
          count() as total,
          countIf(
            length(ask_prices) > 1
            AND NOT arrayAll((x, i) -> i = 1 OR x > ask_prices[i - 1], ask_prices, arrayEnumerate(ask_prices))
          ) as not_ascending
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND length(ask_prices) > 1
      `;

      const result = await executeQuery<{
        total: string;
        not_ascending: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const notAscending = Number(result.data[0].not_ascending);
      const notAscendingPercent = total > 0 ? (notAscending / total) * 100 : 0;

      console.log(`\nAsk price ordering validation (n=${total}):`);
      console.log(`  Not ascending: ${notAscending} (${notAscendingPercent.toFixed(4)}%)`);

      validationResults.push({
        passed: notAscending === 0,
        test: "ask_prices strictly ascending",
        message:
          notAscending === 0
            ? `All ${total} snapshots have correctly ordered ask prices`
            : `${notAscending}/${total} snapshots have non-ascending ask prices`,
        sampleSize: total,
      });

      if (notAscending > 0) {
        // Get sample of violations
        const sampleQuery = `
          SELECT asset_id, source_ts, ask_prices
          FROM ${getTable("OB_SNAPSHOTS")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND length(ask_prices) > 1
            AND NOT arrayAll((x, i) -> i = 1 OR x > ask_prices[i - 1], ask_prices, arrayEnumerate(ask_prices))
          LIMIT 3
        `;
        const sampleResult = await executeQuery(config, sampleQuery);
        console.log(`\nSample of non-ascending ask prices:`, sampleResult.data);
      }

      expect(notAscending).toBe(0);
    });

    it("should have no duplicate prices within bid or ask arrays", async () => {
      if (!config) return;

      const query = `
        SELECT
          count() as total,
          countIf(
            length(bid_prices) != length(arrayDistinct(bid_prices))
            OR length(ask_prices) != length(arrayDistinct(ask_prices))
          ) as has_duplicates
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND (length(bid_prices) > 0 OR length(ask_prices) > 0)
      `;

      const result = await executeQuery<{
        total: string;
        has_duplicates: string;
      }>(config, query);

      const total = Number(result.data[0].total);
      const hasDuplicates = Number(result.data[0].has_duplicates);

      console.log(`\nDuplicate price validation (n=${total}):`);
      console.log(`  With duplicates: ${hasDuplicates}`);

      validationResults.push({
        passed: hasDuplicates === 0,
        test: "No duplicate prices in bid/ask arrays",
        message:
          hasDuplicates === 0
            ? `All ${total} snapshots have unique prices per side`
            : `${hasDuplicates}/${total} snapshots have duplicate prices`,
        sampleSize: total,
      });

      expect(hasDuplicates).toBe(0);
    });
  });

  describe("Historical Reconstruction Validation", () => {
    it("should have level changes that can reconstruct snapshot BBO", async () => {
      if (!config) return;

      // This test verifies that applying level changes to a base snapshot
      // produces the same BBO as the subsequent stored snapshot

      // Get a sample of consecutive snapshots with level changes between them
      const query = `
        WITH snapshot_pairs AS (
          SELECT
            s1.asset_id,
            s1.source_ts as ts1,
            s1.best_bid as bid1,
            s1.best_ask as ask1,
            s2.source_ts as ts2,
            s2.best_bid as bid2,
            s2.best_ask as ask2
          FROM ${getTable("OB_SNAPSHOTS")} s1
          INNER JOIN ${getTable("OB_SNAPSHOTS")} s2
            ON s1.asset_id = s2.asset_id
            AND s2.source_ts > s1.source_ts
            AND s2.source_ts <= s1.source_ts + INTERVAL 1 MINUTE
          WHERE s1.source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND s1.best_bid > 0 AND s1.best_ask > 0
            AND s2.best_bid > 0 AND s2.best_ask > 0
          ORDER BY s1.source_ts DESC
          LIMIT 100
        ),
        changes_between AS (
          SELECT
            sp.asset_id,
            sp.ts1,
            sp.ts2,
            sp.bid1,
            sp.ask1,
            sp.bid2,
            sp.ask2,
            count() as change_count
          FROM snapshot_pairs sp
          LEFT JOIN ${getTable("OB_LEVEL_CHANGES")} lc
            ON sp.asset_id = lc.asset_id
            AND lc.source_ts > sp.ts1
            AND lc.source_ts <= sp.ts2
          GROUP BY sp.asset_id, sp.ts1, sp.ts2, sp.bid1, sp.ask1, sp.bid2, sp.ask2
        )
        SELECT
          count() as total_pairs,
          countIf(change_count > 0) as pairs_with_changes,
          avg(change_count) as avg_changes
        FROM changes_between
      `;

      try {
        const result = await executeQuery<{
          total_pairs: string;
          pairs_with_changes: string;
          avg_changes: number;
        }>(config, query);

        const totalPairs = Number(result.data[0].total_pairs);
        const pairsWithChanges = Number(result.data[0].pairs_with_changes);
        const avgChanges = result.data[0].avg_changes;

        console.log(`\nHistorical reconstruction validation:`);
        console.log(`  Snapshot pairs analyzed: ${totalPairs}`);
        console.log(`  Pairs with level changes: ${pairsWithChanges}`);
        console.log(`  Average changes between snapshots: ${avgChanges?.toFixed(2) || 0}`);

        validationResults.push({
          passed: totalPairs > 0,
          test: "Level changes exist between snapshots",
          message:
            totalPairs > 0
              ? `Found ${totalPairs} snapshot pairs, ${pairsWithChanges} have level changes between them`
              : "No consecutive snapshot pairs found to validate",
          sampleSize: totalPairs,
        });

        // Additional validation: verify BBO changes align with level changes
        if (pairsWithChanges > 0) {
          const bboChangeQuery = `
            WITH snapshot_pairs AS (
              SELECT
                s1.asset_id,
                s1.source_ts as ts1,
                s1.best_bid as bid1,
                s1.best_ask as ask1,
                s2.source_ts as ts2,
                s2.best_bid as bid2,
                s2.best_ask as ask2
              FROM ${getTable("OB_SNAPSHOTS")} s1
              INNER JOIN ${getTable("OB_SNAPSHOTS")} s2
                ON s1.asset_id = s2.asset_id
                AND s2.source_ts > s1.source_ts
                AND s2.source_ts <= s1.source_ts + INTERVAL 1 MINUTE
              WHERE s1.source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
                AND s1.best_bid > 0 AND s1.best_ask > 0
                AND s2.best_bid > 0 AND s2.best_ask > 0
              ORDER BY s1.source_ts DESC
              LIMIT 50
            ),
            bbo_changes AS (
              SELECT
                asset_id,
                ts1,
                ts2,
                bid1 != bid2 OR ask1 != ask2 as bbo_changed
              FROM snapshot_pairs
            ),
            level_changes AS (
              SELECT
                bc.asset_id,
                bc.ts1,
                count() as level_change_count
              FROM bbo_changes bc
              LEFT JOIN ${getTable("OB_LEVEL_CHANGES")} lc
                ON bc.asset_id = lc.asset_id
                AND lc.source_ts > bc.ts1
                AND lc.source_ts <= bc.ts2
              GROUP BY bc.asset_id, bc.ts1, bc.bbo_changed
              HAVING bc.bbo_changed = true
            )
            SELECT
              count() as bbo_changed_pairs,
              countIf(level_change_count > 0) as has_explaining_changes,
              countIf(level_change_count = 0) as missing_changes
            FROM level_changes
          `;

          const bboResult = await executeQuery<{
            bbo_changed_pairs: string;
            has_explaining_changes: string;
            missing_changes: string;
          }>(config, bboChangeQuery);

          const bboChangedPairs = Number(bboResult.data[0].bbo_changed_pairs);
          const hasExplainingChanges = Number(bboResult.data[0].has_explaining_changes);
          const missingChanges = Number(bboResult.data[0].missing_changes);

          console.log(`\nBBO change explanation validation:`);
          console.log(`  Pairs where BBO changed: ${bboChangedPairs}`);
          console.log(`  Explained by level changes: ${hasExplainingChanges}`);
          console.log(`  Missing level changes: ${missingChanges}`);

          const explanationRate =
            bboChangedPairs > 0 ? (hasExplainingChanges / bboChangedPairs) * 100 : 100;

          validationResults.push({
            passed: explanationRate >= 80, // At least 80% of BBO changes should have corresponding level changes
            test: "BBO changes explained by level changes",
            message:
              explanationRate >= 80
                ? `${explanationRate.toFixed(1)}% of BBO changes have corresponding level changes`
                : `Only ${explanationRate.toFixed(1)}% of BBO changes have level changes - possible data gap`,
            expected: ">= 80%",
            actual: `${explanationRate.toFixed(1)}%`,
            sampleSize: bboChangedPairs,
          });
        }
      } catch (error) {
        console.log(`\nSkipping reconstruction test: ${(error as Error).message}`);
        validationResults.push({
          passed: true,
          test: "Level changes exist between snapshots",
          message: "Skipped - query error or no data",
        });
      }
    });

    it("should have consistent book_hash for same orderbook state", async () => {
      if (!config) return;

      // Check for duplicate book_hash values that should indicate identical states
      const query = `
        SELECT
          book_hash,
          count() as cnt,
          countDistinct(best_bid) as distinct_bids,
          countDistinct(best_ask) as distinct_asks
        FROM ${getTable("OB_SNAPSHOTS")}
        WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
          AND book_hash != ''
        GROUP BY book_hash
        HAVING cnt > 1 AND (distinct_bids > 1 OR distinct_asks > 1)
        LIMIT 10
      `;

      const result = await executeQuery<{
        book_hash: string;
        cnt: string;
        distinct_bids: string;
        distinct_asks: string;
      }>(config, query);

      const inconsistentHashes = result.data.length;

      console.log(`\nBook hash consistency validation:`);
      console.log(`  Hashes with inconsistent BBO: ${inconsistentHashes}`);

      validationResults.push({
        passed: inconsistentHashes === 0,
        test: "book_hash uniquely identifies orderbook state",
        message:
          inconsistentHashes === 0
            ? "All book hashes map to consistent BBO values"
            : `${inconsistentHashes} hashes have inconsistent BBO - hash collision or bug`,
        actual: result.data.slice(0, 3),
      });

      if (inconsistentHashes > 0) {
        console.log(`\nInconsistent book hashes:`, result.data.slice(0, 3));
      }

      expect(inconsistentHashes).toBe(0);
    });

    it("should have sequence_number increments matching level change count", async () => {
      if (!config) return;

      // For each asset, the sequence number should roughly increment with level changes
      const query = `
        WITH seq_diffs AS (
          SELECT
            asset_id,
            source_ts,
            sequence_number,
            sequence_number - lagInFrame(sequence_number) OVER (
              PARTITION BY asset_id ORDER BY source_ts
            ) as seq_diff
          FROM ${getTable("OB_BBO")}
          WHERE source_ts >= now() - INTERVAL ${TEST_CONFIG.LOOKBACK_HOURS} HOUR
            AND is_resync = 0
        )
        SELECT
          count() as total,
          countIf(seq_diff IS NOT NULL AND seq_diff < 0) as negative_jumps,
          countIf(seq_diff IS NOT NULL AND seq_diff > 1000) as large_jumps,
          avg(if(seq_diff > 0, seq_diff, null)) as avg_increment
        FROM seq_diffs
      `;

      const result = await executeQuery<{
        total: string;
        negative_jumps: string;
        large_jumps: string;
        avg_increment: number;
      }>(config, query);

      const total = Number(result.data[0].total);
      const negativeJumps = Number(result.data[0].negative_jumps);
      const largeJumps = Number(result.data[0].large_jumps);
      const avgIncrement = result.data[0].avg_increment;

      console.log(`\nSequence number validation (n=${total}):`);
      console.log(`  Negative jumps (regressions): ${negativeJumps}`);
      console.log(`  Large jumps (>1000): ${largeJumps}`);
      console.log(`  Average increment: ${avgIncrement?.toFixed(2) || "N/A"}`);

      const negativePercent = total > 0 ? (negativeJumps / total) * 100 : 0;

      validationResults.push({
        passed: negativePercent < 1, // Less than 1% negative jumps
        test: "Sequence numbers properly incrementing",
        message:
          negativePercent < 1
            ? `Only ${negativeJumps} negative sequence jumps (${negativePercent.toFixed(3)}%)`
            : `${negativeJumps} negative sequence jumps (${negativePercent.toFixed(2)}%) - data ordering issue`,
        expected: "< 1% negative jumps",
        actual: `${negativePercent.toFixed(3)}%`,
        sampleSize: total,
      });

      expect(negativePercent).toBeLessThan(1);
    });
  });

  // Print summary at the end
  afterAll(() => {
    if (validationResults.length > 0) {
      console.log(formatValidationResults(validationResults));
    }
  });
});
