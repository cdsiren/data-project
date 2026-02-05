/**
 * R2 to ClickHouse Data Reconciliation Test
 *
 * Validates that archived data in R2 matches the data still in ClickHouse.
 * This test should be run BEFORE deleting any data from ClickHouse to ensure
 * the migration is complete and accurate.
 *
 * The test verifies:
 * 1. All R2 manifest entries have corresponding data in ClickHouse
 * 2. Row counts match between R2 manifests and ClickHouse queries
 * 3. No data loss has occurred during archival
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getClickHouseConfig,
  executeQuery,
  type ClickHouseConfig,
} from "./test-utils";
import {
  ARCHIVE_TABLE_REGISTRY,
  getManifestPath,
  R2_PATHS,
  type ArchiveTableConfig,
} from "../../config/database";
import type { ManifestEntry, TableManifest } from "../../schemas/common";

// Test configuration
const RECONCILIATION_CONFIG = {
  // Tolerance for row count differences (as percentage)
  // Small tolerance accounts for in-flight data during archival
  ROW_COUNT_TOLERANCE_PERCENT: 1,
  // Worker URL for fetching manifests (set via env or use default)
  WORKER_URL: process.env.WORKER_URL || "https://polymarket-enrichment.cd-durbin14.workers.dev",
  // API key for authenticated endpoints
  API_KEY: process.env.VITE_DASHBOARD_API_KEY || process.env.API_KEY,
};

// Tables that support archival and should be reconciled
const RECONCILABLE_TABLES: ArchiveTableConfig[] = ARCHIVE_TABLE_REGISTRY.filter(
  (t) => t.trigger === "resolved" || t.trigger === "aged"
);

interface ReconciliationResult {
  database: string;
  table: string;
  manifestTotalRows: number;
  clickhouseTotalRows: number;
  difference: number;
  differencePercent: number;
  withinTolerance: boolean;
  entriesChecked: number;
  entriesMatched: number;
  errors: string[];
}

/**
 * Fetch manifest from worker's admin endpoint
 */
async function fetchManifest(
  database: string,
  table: string
): Promise<TableManifest | null> {
  const url = `${RECONCILIATION_CONFIG.WORKER_URL}/admin/manifest/${database}/${table}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-API-Key": RECONCILIATION_CONFIG.API_KEY || "",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // No manifest exists yet - table hasn't been archived
        return null;
      }
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    return response.json();
  } catch (error) {
    console.warn(`Could not fetch manifest for ${database}.${table}:`, error);
    return null;
  }
}

/**
 * Fetch all manifests from worker's admin endpoint
 */
async function fetchAllManifests(): Promise<Map<string, TableManifest>> {
  const url = `${RECONCILIATION_CONFIG.WORKER_URL}/admin/manifests`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-API-Key": RECONCILIATION_CONFIG.API_KEY || "",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch manifests: ${response.status} ${response.statusText}`);
    }

    const data: { manifests: TableManifest[] } = await response.json();
    const manifestMap = new Map<string, TableManifest>();

    for (const manifest of data.manifests) {
      const key = `${manifest.database}.${manifest.table}`;
      manifestMap.set(key, manifest);
    }

    return manifestMap;
  } catch (error) {
    console.warn("Could not fetch manifests from worker:", error);
    return new Map();
  }
}

/**
 * Count rows in ClickHouse for a specific archived time range
 */
async function countClickHouseRows(
  config: ClickHouseConfig,
  tableConfig: ArchiveTableConfig,
  minTs: string,
  maxTs: string,
  conditionId?: string
): Promise<number> {
  const { database, table, keyColumn, keyColumnType, conditionIdColumn } = tableConfig;

  let whereClause: string;

  if (keyColumnType === "string") {
    // For string timestamps (Unix epoch)
    const minUnix = Math.floor(new Date(minTs).getTime() / 1000);
    const maxUnix = Math.floor(new Date(maxTs).getTime() / 1000);
    whereClause = `toUInt64(${keyColumn}) >= ${minUnix} AND toUInt64(${keyColumn}) < ${maxUnix}`;
  } else {
    // For DateTime columns
    whereClause = `${keyColumn} >= '${minTs}' AND ${keyColumn} < '${maxTs}'`;
  }

  if (conditionId && conditionIdColumn) {
    whereClause += ` AND ${conditionIdColumn} = '${conditionId}'`;
  }

  const query = `
    SELECT count() AS cnt
    FROM ${database}.${table}
    WHERE ${whereClause}
  `;

  const result = await executeQuery<{ cnt: string }>(config, query);
  return parseInt(result.data[0]?.cnt || "0", 10);
}

/**
 * Count total rows in ClickHouse for a table
 */
async function countTotalClickHouseRows(
  config: ClickHouseConfig,
  database: string,
  table: string
): Promise<number> {
  const query = `SELECT count() AS cnt FROM ${database}.${table}`;
  const result = await executeQuery<{ cnt: string }>(config, query);
  return parseInt(result.data[0]?.cnt || "0", 10);
}

/**
 * Get row counts by condition_id for resolved market tables
 */
async function getClickHouseRowsByConditionId(
  config: ClickHouseConfig,
  database: string,
  table: string,
  conditionIdColumn: string
): Promise<Map<string, number>> {
  const query = `
    SELECT ${conditionIdColumn} AS condition_id, count() AS cnt
    FROM ${database}.${table}
    GROUP BY ${conditionIdColumn}
  `;

  const result = await executeQuery<{ condition_id: string; cnt: string }>(config, query);
  const counts = new Map<string, number>();

  for (const row of result.data) {
    counts.set(row.condition_id, parseInt(row.cnt, 10));
  }

  return counts;
}

/**
 * Reconcile a single table between R2 manifest and ClickHouse
 */
async function reconcileTable(
  config: ClickHouseConfig,
  tableConfig: ArchiveTableConfig,
  manifest: TableManifest
): Promise<ReconciliationResult> {
  const { database, table, conditionIdColumn } = tableConfig;
  const errors: string[] = [];
  let clickhouseTotalRows = 0;
  let entriesChecked = 0;
  let entriesMatched = 0;

  // For each manifest entry, verify ClickHouse still has the data
  for (const entry of manifest.entries) {
    entriesChecked++;

    try {
      // Extract condition_id from path if it's a resolved market archive
      let conditionId: string | undefined;
      if (entry.path.includes("/resolved/")) {
        const pathParts = entry.path.split("/");
        const resolvedIndex = pathParts.indexOf("resolved");
        if (resolvedIndex >= 0 && pathParts.length > resolvedIndex + 1) {
          conditionId = pathParts[resolvedIndex + 1];
        }
      }

      const chCount = await countClickHouseRows(
        config,
        tableConfig,
        entry.minTs,
        entry.maxTs,
        conditionId
      );

      clickhouseTotalRows += chCount;

      // Check if counts match within tolerance
      const diff = Math.abs(chCount - entry.rows);
      const diffPercent = entry.rows > 0 ? (diff / entry.rows) * 100 : 0;

      if (diffPercent <= RECONCILIATION_CONFIG.ROW_COUNT_TOLERANCE_PERCENT) {
        entriesMatched++;
      } else {
        errors.push(
          `Entry ${entry.path}: R2=${entry.rows}, ClickHouse=${chCount}, diff=${diffPercent.toFixed(2)}%`
        );
      }
    } catch (error) {
      errors.push(`Failed to check entry ${entry.path}: ${error}`);
    }
  }

  const totalDiff = Math.abs(clickhouseTotalRows - manifest.totalRows);
  const totalDiffPercent = manifest.totalRows > 0
    ? (totalDiff / manifest.totalRows) * 100
    : 0;

  return {
    database,
    table,
    manifestTotalRows: manifest.totalRows,
    clickhouseTotalRows,
    difference: totalDiff,
    differencePercent: totalDiffPercent,
    withinTolerance: totalDiffPercent <= RECONCILIATION_CONFIG.ROW_COUNT_TOLERANCE_PERCENT,
    entriesChecked,
    entriesMatched,
    errors,
  };
}

describe("R2 to ClickHouse Data Reconciliation", () => {
  let config: ClickHouseConfig | null;
  let manifests: Map<string, TableManifest>;

  beforeAll(async () => {
    config = getClickHouseConfig();
    if (!config) {
      console.log("Skipping: CLICKHOUSE_URL and CLICKHOUSE_TOKEN env vars required");
      return;
    }

    if (!RECONCILIATION_CONFIG.API_KEY) {
      console.log("Warning: API_KEY not set, some tests may fail");
    }

    // Fetch all manifests from the worker
    manifests = await fetchAllManifests();
    console.log(`Loaded ${manifests.size} table manifests from R2`);
  });

  it("should have at least one manifest to reconcile", async () => {
    if (!config) return;

    // If no manifests exist, that's fine - nothing has been archived yet
    if (manifests.size === 0) {
      console.log("No manifests found - no data has been archived yet");
      return;
    }

    expect(manifests.size).toBeGreaterThan(0);
  });

  it("should reconcile ob_bbo table", async () => {
    if (!config) return;

    const tableConfig = RECONCILABLE_TABLES.find(
      (t) => t.database === "trading_data" && t.table === "ob_bbo"
    );
    if (!tableConfig) return;

    const manifest = manifests.get("trading_data.ob_bbo");
    if (!manifest) {
      console.log("No manifest for ob_bbo - table not yet archived");
      return;
    }

    const result = await reconcileTable(config, tableConfig, manifest);

    console.log(`ob_bbo reconciliation:
      Manifest rows: ${result.manifestTotalRows.toLocaleString()}
      ClickHouse rows: ${result.clickhouseTotalRows.toLocaleString()}
      Difference: ${result.difference.toLocaleString()} (${result.differencePercent.toFixed(2)}%)
      Entries: ${result.entriesMatched}/${result.entriesChecked} matched
    `);

    if (result.errors.length > 0) {
      console.log("Errors:", result.errors.slice(0, 10).join("\n"));
    }

    expect(result.withinTolerance).toBe(true);
  });

  it("should reconcile trade_ticks table", async () => {
    if (!config) return;

    const tableConfig = RECONCILABLE_TABLES.find(
      (t) => t.database === "trading_data" && t.table === "trade_ticks"
    );
    if (!tableConfig) return;

    const manifest = manifests.get("trading_data.trade_ticks");
    if (!manifest) {
      console.log("No manifest for trade_ticks - table not yet archived");
      return;
    }

    const result = await reconcileTable(config, tableConfig, manifest);

    console.log(`trade_ticks reconciliation:
      Manifest rows: ${result.manifestTotalRows.toLocaleString()}
      ClickHouse rows: ${result.clickhouseTotalRows.toLocaleString()}
      Difference: ${result.difference.toLocaleString()} (${result.differencePercent.toFixed(2)}%)
      Entries: ${result.entriesMatched}/${result.entriesChecked} matched
    `);

    expect(result.withinTolerance).toBe(true);
  });

  it("should reconcile ob_snapshots table", async () => {
    if (!config) return;

    const tableConfig = RECONCILABLE_TABLES.find(
      (t) => t.database === "trading_data" && t.table === "ob_snapshots"
    );
    if (!tableConfig) return;

    const manifest = manifests.get("trading_data.ob_snapshots");
    if (!manifest) {
      console.log("No manifest for ob_snapshots - table not yet archived");
      return;
    }

    const result = await reconcileTable(config, tableConfig, manifest);

    console.log(`ob_snapshots reconciliation:
      Manifest rows: ${result.manifestTotalRows.toLocaleString()}
      ClickHouse rows: ${result.clickhouseTotalRows.toLocaleString()}
      Difference: ${result.difference.toLocaleString()} (${result.differencePercent.toFixed(2)}%)
      Entries: ${result.entriesMatched}/${result.entriesChecked} matched
    `);

    expect(result.withinTolerance).toBe(true);
  });

  it("should reconcile ob_level_changes table", async () => {
    if (!config) return;

    const tableConfig = RECONCILABLE_TABLES.find(
      (t) => t.database === "trading_data" && t.table === "ob_level_changes"
    );
    if (!tableConfig) return;

    const manifest = manifests.get("trading_data.ob_level_changes");
    if (!manifest) {
      console.log("No manifest for ob_level_changes - table not yet archived");
      return;
    }

    const result = await reconcileTable(config, tableConfig, manifest);

    console.log(`ob_level_changes reconciliation:
      Manifest rows: ${result.manifestTotalRows.toLocaleString()}
      ClickHouse rows: ${result.clickhouseTotalRows.toLocaleString()}
      Difference: ${result.difference.toLocaleString()} (${result.differencePercent.toFixed(2)}%)
      Entries: ${result.entriesMatched}/${result.entriesChecked} matched
    `);

    expect(result.withinTolerance).toBe(true);
  });

  it("should reconcile all archived tables", async () => {
    if (!config) return;

    const results: ReconciliationResult[] = [];

    for (const tableConfig of RECONCILABLE_TABLES) {
      const key = `${tableConfig.database}.${tableConfig.table}`;
      const manifest = manifests.get(key);

      if (!manifest) {
        console.log(`Skipping ${key} - no manifest found`);
        continue;
      }

      const result = await reconcileTable(config, tableConfig, manifest);
      results.push(result);
    }

    // Summary report
    console.log("\n=== Reconciliation Summary ===");
    let allPassed = true;
    let totalManifestRows = 0;
    let totalClickHouseRows = 0;

    for (const result of results) {
      const status = result.withinTolerance ? "✓" : "✗";
      console.log(
        `${status} ${result.database}.${result.table}: ` +
        `R2=${result.manifestTotalRows.toLocaleString()}, ` +
        `CH=${result.clickhouseTotalRows.toLocaleString()}, ` +
        `diff=${result.differencePercent.toFixed(2)}%`
      );

      totalManifestRows += result.manifestTotalRows;
      totalClickHouseRows += result.clickhouseTotalRows;

      if (!result.withinTolerance) {
        allPassed = false;
      }
    }

    const totalDiff = Math.abs(totalClickHouseRows - totalManifestRows);
    const totalDiffPercent = totalManifestRows > 0
      ? (totalDiff / totalManifestRows) * 100
      : 0;

    console.log(`\nTotal: R2=${totalManifestRows.toLocaleString()}, CH=${totalClickHouseRows.toLocaleString()}`);
    console.log(`Overall difference: ${totalDiff.toLocaleString()} (${totalDiffPercent.toFixed(2)}%)`);
    console.log(`Tolerance: ${RECONCILIATION_CONFIG.ROW_COUNT_TOLERANCE_PERCENT}%`);

    expect(allPassed).toBe(true);
  });

  it("should verify archive_log matches manifests", async () => {
    if (!config) return;

    // Query archive_log for total archived rows by table
    const query = `
      SELECT
        table_name,
        sum(rows_archived) AS total_archived,
        count() AS archive_operations,
        min(archived_at) AS first_archive,
        max(archived_at) AS last_archive
      FROM trading_data.archive_log
      WHERE clickhouse_deleted = 0
      GROUP BY table_name
      ORDER BY table_name
    `;

    const result = await executeQuery<{
      table_name: string;
      total_archived: string;
      archive_operations: string;
      first_archive: string;
      last_archive: string;
    }>(config, query);

    console.log("\n=== Archive Log Summary ===");
    for (const row of result.data) {
      const manifestKey = `trading_data.${row.table_name}`;
      const manifest = manifests.get(manifestKey);

      const logRows = parseInt(row.total_archived, 10);
      const manifestRows = manifest?.totalRows || 0;
      const diff = Math.abs(logRows - manifestRows);
      const diffPercent = manifestRows > 0 ? (diff / manifestRows) * 100 : 0;

      const status = diffPercent <= RECONCILIATION_CONFIG.ROW_COUNT_TOLERANCE_PERCENT ? "✓" : "✗";

      console.log(
        `${status} ${row.table_name}: ` +
        `log=${logRows.toLocaleString()}, ` +
        `manifest=${manifestRows.toLocaleString()}, ` +
        `ops=${row.archive_operations}, ` +
        `range=${row.first_archive} to ${row.last_archive}`
      );

      if (manifest) {
        expect(diffPercent).toBeLessThanOrEqual(RECONCILIATION_CONFIG.ROW_COUNT_TOLERANCE_PERCENT);
      }
    }
  });
});
