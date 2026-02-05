// src/services/archive-service.ts
// Core archival service for exporting data to R2 in Parquet format

import type { Env } from "../types";
import type { ArchiveJob, ArchiveType, ManifestEntry, TableManifest } from "../schemas/common";
import {
  DB_CONFIG,
  ARCHIVE_TABLE_REGISTRY,
  getArchivePath,
  getManifestPath,
  getResolvedMarketTables,
  getTablesForTrigger,
  calculateBlockCutoff,
  type ArchiveTableConfig,
} from "../config/database";
import { escapeString, safeIdentifier } from "../utils/sql-sanitization";

// ============================================================
// Types
// ============================================================

export interface ArchiveResult {
  success: boolean;
  database: string;
  table: string;
  archiveType: ArchiveType;
  rowsArchived: number;
  r2Path: string;
  minTs?: string;
  maxTs?: string;
  error?: string;
}

// Maximum retries for manifest updates (optimistic locking)
const MANIFEST_UPDATE_MAX_RETRIES = 5;
const MANIFEST_RETRY_DELAY_MS = 100;

// ============================================================
// Archive Service
// ============================================================

export class ArchiveService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Archive all data for a resolved market (end_date > 7 days ago)
   * Archives ob_bbo, ob_snapshots, trade_ticks, ob_level_changes
   */
  async archiveResolvedMarket(conditionId: string): Promise<ArchiveResult[]> {
    const results: ArchiveResult[] = [];
    const tables = getResolvedMarketTables();

    console.log(`[Archive] Starting archive for resolved market ${conditionId.slice(0, 20)}...`);

    for (const tableConfig of tables) {
      try {
        const result = await this.archiveTableForMarket(tableConfig, conditionId);
        results.push(result);

        if (result.success && result.rowsArchived > 0) {
          // Log to archive_log
          await this.logArchive(conditionId, "resolved", tableConfig.table, result);
        }
      } catch (error) {
        console.error(
          `[Archive] Failed to archive ${tableConfig.table} for market ${conditionId.slice(0, 20)}...:`,
          error
        );
        results.push({
          success: false,
          database: tableConfig.database,
          table: tableConfig.table,
          archiveType: "resolved",
          rowsArchived: 0,
          r2Path: "",
          error: String(error),
        });
      }
    }

    return results;
  }

  /**
   * Archive aged data for a specific table (>90 days old)
   * Archives data in monthly chunks to avoid worker timeouts
   */
  async archiveAgedTable(
    database: string,
    table: string,
    cutoffDate: Date,
    month?: string
  ): Promise<ArchiveResult> {
    const tableConfig = ARCHIVE_TABLE_REGISTRY.find(
      (t) => t.database === database && t.table === table
    );

    if (!tableConfig) {
      return {
        success: false,
        database,
        table,
        archiveType: "aged",
        rowsArchived: 0,
        r2Path: "",
        error: `Table ${database}.${table} not found in archive registry`,
      };
    }

    console.log(`[Archive] Archiving aged data from ${database}.${table} before ${cutoffDate.toISOString()}`);

    try {
      // Validate identifiers to prevent SQL injection
      const safeDatabase = safeIdentifier(database, "database");
      const safeTable = safeIdentifier(table, "table");
      const safeKeyCol = safeIdentifier(tableConfig.keyColumn, "column");

      // Handle block_range tables differently (no monthly chunking)
      if (tableConfig.trigger === "block_range") {
        return this.archiveBlockRangeTable(tableConfig, cutoffDate, month);
      }

      // For timestamp-based tables, archive in monthly chunks
      // First, get the date range of archivable data
      const cutoffUnix = Math.floor(cutoffDate.getTime() / 1000);
      const cutoffStr = cutoffDate.toISOString();

      const rangeQuery = tableConfig.keyColumnType === "string"
        ? `
          SELECT
            toDateTime(min(toUInt64(${safeKeyCol}))) AS min_ts,
            toDateTime(max(toUInt64(${safeKeyCol}))) AS max_ts,
            count() AS row_count
          FROM ${safeDatabase}.${safeTable}
          WHERE toUInt64(${safeKeyCol}) < ${cutoffUnix}
          FORMAT JSON
        `
        : `
          SELECT
            min(${safeKeyCol}) AS min_ts,
            max(${safeKeyCol}) AS max_ts,
            count() AS row_count
          FROM ${safeDatabase}.${safeTable}
          WHERE ${safeKeyCol} < '${cutoffStr}'
          FORMAT JSON
        `;

      const rangeResult = await this.executeQuery(rangeQuery);

      // Distinguish query failure from empty results
      if (!rangeResult.success) {
        console.error(`[Archive] Query failed for ${database}.${table}: ${rangeResult.error}`);
        return {
          success: false,
          database,
          table,
          archiveType: "aged",
          rowsArchived: 0,
          r2Path: "",
          error: rangeResult.error || "Query failed",
        };
      }

      if (!rangeResult.data?.[0]) {
        console.log(`[Archive] No archivable data found in ${database}.${table}`);
        return {
          success: true,
          database,
          table,
          archiveType: "aged",
          rowsArchived: 0,
          r2Path: "",
        };
      }

      const { min_ts, max_ts, row_count } = rangeResult.data[0];
      if (row_count === 0 || row_count === "0") {
        console.log(`[Archive] No rows to archive in ${database}.${table}`);
        return {
          success: true,
          database,
          table,
          archiveType: "aged",
          rowsArchived: 0,
          r2Path: "",
        };
      }

      console.log(`[Archive] Found ${row_count} rows to archive in ${database}.${table} (${min_ts} to ${max_ts})`);

      // If a specific month was requested, only archive that month
      if (month) {
        return this.archiveAgedTableMonth(tableConfig, cutoffDate, month);
      }

      // Archive each month separately
      const months = this.getMonthsBetween(new Date(min_ts), new Date(max_ts));
      let totalArchived = 0;
      let lastPath = "";
      let firstMinTs: string | undefined;
      let lastMaxTs: string | undefined;

      for (const archiveMonth of months) {
        const monthResult = await this.archiveAgedTableMonth(tableConfig, cutoffDate, archiveMonth);

        if (monthResult.success && monthResult.rowsArchived > 0) {
          totalArchived += monthResult.rowsArchived;
          lastPath = monthResult.r2Path;
          if (!firstMinTs) firstMinTs = monthResult.minTs;
          lastMaxTs = monthResult.maxTs;
        }
      }

      return {
        success: true,
        database,
        table,
        archiveType: "aged",
        rowsArchived: totalArchived,
        r2Path: lastPath,
        minTs: firstMinTs,
        maxTs: lastMaxTs,
      };
    } catch (error) {
      console.error(`[Archive] Failed to archive aged data from ${database}.${table}:`, error);
      return {
        success: false,
        database,
        table,
        archiveType: "aged",
        rowsArchived: 0,
        r2Path: "",
        error: String(error),
      };
    }
  }

  // Maximum rows per archive chunk to avoid worker timeouts
  // 500K rows typically produces ~50-100MB Parquet files
  private static readonly MAX_ROWS_PER_CHUNK = 500000;

  /**
   * Archive a single month of aged data for a table
   * Automatically splits into weeks or days if the month has too many rows
   */
  private async archiveAgedTableMonth(
    tableConfig: ArchiveTableConfig,
    cutoffDate: Date,
    month: string
  ): Promise<ArchiveResult> {
    const { database, table, keyColumn, keyColumnType } = tableConfig;
    const safeDatabase = safeIdentifier(database, "database");
    const safeTable = safeIdentifier(table, "table");
    const safeKeyCol = safeIdentifier(keyColumn, "column");

    const monthStart = `${month}-01`;
    const monthEnd = this.getMonthEnd(month);
    const cutoffStr = cutoffDate.toISOString();
    const cutoffUnix = Math.floor(cutoffDate.getTime() / 1000);

    // First, check how many rows are in this month
    const countQuery = keyColumnType === "string"
      ? `
        SELECT count() as cnt
        FROM ${safeDatabase}.${safeTable}
        WHERE toUInt64(${safeKeyCol}) >= ${Math.floor(new Date(monthStart).getTime() / 1000)}
          AND toUInt64(${safeKeyCol}) < ${Math.min(Math.floor(new Date(monthEnd).getTime() / 1000), cutoffUnix)}
        FORMAT JSON
      `
      : `
        SELECT count() as cnt
        FROM ${safeDatabase}.${safeTable}
        WHERE ${safeKeyCol} >= '${monthStart}'
          AND ${safeKeyCol} < least('${monthEnd}', '${cutoffStr}')
        FORMAT JSON
      `;

    const countResult = await this.executeQuery(countQuery);

    // Check for query failure before using data
    if (!countResult.success) {
      console.error(
        `[Archive] Count query failed for ${database}.${table} (month: ${month}): ${countResult.error}`
      );
      return {
        success: false,
        database,
        table,
        archiveType: "aged",
        rowsArchived: 0,
        r2Path: "",
        error: countResult.error || "Count query failed",
      };
    }

    const rowCount = countResult.data?.[0]?.cnt || 0;
    const numRows = typeof rowCount === "string" ? parseInt(rowCount, 10) : rowCount;

    if (numRows === 0) {
      return {
        success: true,
        database,
        table,
        archiveType: "aged",
        rowsArchived: 0,
        r2Path: "",
      };
    }

    // If month has too many rows, split into smaller chunks
    if (numRows > ArchiveService.MAX_ROWS_PER_CHUNK) {
      console.log(`[Archive] Month ${month} has ${numRows} rows, splitting into smaller chunks`);
      return this.archiveAgedTableChunked(tableConfig, cutoffDate, month, numRows);
    }

    // Month is small enough, archive directly
    return this.archiveAgedTableChunk(tableConfig, cutoffDate, monthStart, monthEnd, month);
  }

  /**
   * Archive a month in weekly or daily chunks when it has too many rows
   */
  private async archiveAgedTableChunked(
    tableConfig: ArchiveTableConfig,
    cutoffDate: Date,
    month: string,
    totalRows: number
  ): Promise<ArchiveResult> {
    const { database, table } = tableConfig;
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const monthEnd = new Date(this.getMonthEnd(month) + "T00:00:00Z");

    // Estimate rows per day
    const daysInMonth = Math.ceil((monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000));
    const avgRowsPerDay = totalRows / daysInMonth;

    // Determine chunk size: weekly if avg daily rows fit in a week, otherwise daily
    const useWeeklyChunks = avgRowsPerDay * 7 <= ArchiveService.MAX_ROWS_PER_CHUNK;
    const chunkDays = useWeeklyChunks ? 7 : 1;
    const chunkType = useWeeklyChunks ? "week" : "day";

    console.log(`[Archive] Splitting ${month} into ${chunkType}ly chunks (~${Math.round(avgRowsPerDay * chunkDays)} rows per chunk)`);

    let totalArchived = 0;
    let lastPath = "";
    let firstMinTs: string | undefined;
    let lastMaxTs: string | undefined;
    let chunkIndex = 0;
    let failedChunks = 0;
    const failedErrors: string[] = [];

    const current = new Date(monthStart);
    while (current < monthEnd && current < cutoffDate) {
      const chunkStart = current.toISOString().split("T")[0];

      // Advance by chunk size
      current.setUTCDate(current.getUTCDate() + chunkDays);

      // Don't go past month end or cutoff
      const chunkEndDate = new Date(Math.min(current.getTime(), monthEnd.getTime(), cutoffDate.getTime()));
      const chunkEnd = chunkEndDate.toISOString().split("T")[0];

      if (chunkStart >= chunkEnd) continue;

      // Create a unique path for this chunk: YYYY-MM/chunk-NN
      const chunkPath = `${month}/chunk-${String(chunkIndex).padStart(2, "0")}`;

      const result = await this.archiveAgedTableChunk(
        tableConfig,
        cutoffDate,
        chunkStart,
        chunkEnd,
        chunkPath
      );

      if (result.success) {
        if (result.rowsArchived > 0) {
          totalArchived += result.rowsArchived;
          lastPath = result.r2Path;
          if (!firstMinTs) firstMinTs = result.minTs;
          lastMaxTs = result.maxTs;
        }
      } else {
        failedChunks++;
        failedErrors.push(`chunk-${chunkIndex}: ${result.error || "unknown error"}`);
        console.error(`[Archive] Chunk ${chunkIndex} failed for ${database}.${table}: ${result.error}`);
      }

      chunkIndex++;
    }

    // Report failure if any chunks failed
    if (failedChunks > 0) {
      console.error(`[Archive] ${month}: ${failedChunks}/${chunkIndex} chunks failed`);
      return {
        success: false,
        database,
        table,
        archiveType: "aged",
        rowsArchived: totalArchived,
        r2Path: lastPath,
        minTs: firstMinTs,
        maxTs: lastMaxTs,
        error: `${failedChunks}/${chunkIndex} chunks failed: ${failedErrors.slice(0, 3).join("; ")}`,
      };
    }

    console.log(`[Archive] Completed ${month}: ${totalArchived} rows in ${chunkIndex} chunks`);

    return {
      success: true,
      database,
      table,
      archiveType: "aged",
      rowsArchived: totalArchived,
      r2Path: lastPath,
      minTs: firstMinTs,
      maxTs: lastMaxTs,
    };
  }

  /**
   * Archive a specific date range chunk
   */
  private async archiveAgedTableChunk(
    tableConfig: ArchiveTableConfig,
    cutoffDate: Date,
    startDate: string,
    endDate: string,
    pathSuffix: string
  ): Promise<ArchiveResult> {
    const { database, table, keyColumn, keyColumnType } = tableConfig;
    const safeDatabase = safeIdentifier(database, "database");
    const safeTable = safeIdentifier(table, "table");
    const safeKeyCol = safeIdentifier(keyColumn, "column");

    const cutoffStr = cutoffDate.toISOString();
    const cutoffUnix = Math.floor(cutoffDate.getTime() / 1000);

    // Build query for this chunk
    let query: string;
    if (keyColumnType === "string") {
      const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
      const endUnix = Math.floor(new Date(endDate).getTime() / 1000);
      query = `
        SELECT *
        FROM ${safeDatabase}.${safeTable}
        WHERE toUInt64(${safeKeyCol}) >= ${startUnix}
          AND toUInt64(${safeKeyCol}) < ${Math.min(endUnix, cutoffUnix)}
      `;
    } else {
      query = `
        SELECT *
        FROM ${safeDatabase}.${safeTable}
        WHERE ${safeKeyCol} >= '${startDate}'
          AND ${safeKeyCol} < least('${endDate}', '${cutoffStr}')
      `;
    }

    const r2Path = getArchivePath(database, table, "aged", { month: pathSuffix });
    const result = await this.exportAndUpload(query, r2Path);

    if (result.success && result.rowsArchived > 0) {
      // Update manifest
      await this.updateManifest(database, table, {
        path: r2Path,
        rows: result.rowsArchived,
        minTs: startDate,
        maxTs: endDate,
        archivedAt: new Date().toISOString(),
      });

      // Log to archive_log
      const archiveResult: ArchiveResult = {
        success: result.success,
        database,
        table,
        archiveType: "aged",
        rowsArchived: result.rowsArchived,
        r2Path,
        minTs: startDate,
        maxTs: endDate,
      };
      await this.logArchive(null, "aged", table, archiveResult);

      console.log(`[Archive] Archived ${result.rowsArchived} rows from ${database}.${table} for ${pathSuffix}`);
    }

    return {
      success: result.success,
      database,
      table,
      archiveType: "aged",
      rowsArchived: result.rowsArchived,
      r2Path,
      minTs: startDate,
      maxTs: endDate,
      error: result.error,
    };
  }

  /**
   * Archive block_range tables (no monthly chunking, uses block numbers)
   */
  private async archiveBlockRangeTable(
    tableConfig: ArchiveTableConfig,
    cutoffDate: Date,
    month?: string
  ): Promise<ArchiveResult> {
    const { database, table, keyColumn } = tableConfig;
    const safeDatabase = safeIdentifier(database, "database");
    const safeTable = safeIdentifier(table, "table");
    const safeKeyCol = safeIdentifier(keyColumn, "column");

    const cutoffBlock = await this.getCurrentBlockCutoff();
    const query = `
      SELECT *
      FROM ${safeDatabase}.${safeTable}
      WHERE toUInt64(extractAllGroups(${safeKeyCol}, '\\\\[(\\\\d+),')[1][1]) < ${cutoffBlock}
    `;

    const archiveMonth = month || this.getMonthFromDate(cutoffDate);
    const r2Path = getArchivePath(database, table, "aged", { month: archiveMonth });
    const result = await this.exportAndUpload(query, r2Path);

    if (result.success && result.rowsArchived > 0) {
      await this.updateManifest(database, table, {
        path: r2Path,
        rows: result.rowsArchived,
        minTs: result.minTs || cutoffDate.toISOString(),
        maxTs: result.maxTs || cutoffDate.toISOString(),
        archivedAt: new Date().toISOString(),
      });

      await this.logArchive(null, "aged", table, {
        success: result.success,
        database,
        table,
        archiveType: "aged",
        rowsArchived: result.rowsArchived,
        r2Path,
        minTs: result.minTs,
        maxTs: result.maxTs,
      });
    }

    return {
      success: result.success,
      database,
      table,
      archiveType: "aged",
      rowsArchived: result.rowsArchived,
      r2Path,
      minTs: result.minTs,
      maxTs: result.maxTs,
      error: result.error,
    };
  }

  /**
   * Archive a specific table for a resolved market
   */
  private async archiveTableForMarket(
    tableConfig: ArchiveTableConfig,
    conditionId: string
  ): Promise<ArchiveResult> {
    const { database, table, keyColumn, conditionIdColumn } = tableConfig;

    // Validate identifiers to prevent SQL injection
    const safeDatabase = safeIdentifier(database, "database");
    const safeTable = safeIdentifier(table, "table");
    const safeKeyColumn = safeIdentifier(keyColumn, "column");
    const safeConditionIdColumn = conditionIdColumn ? safeIdentifier(conditionIdColumn, "column") : null;

    // Escape user-provided values
    const safeConditionId = escapeString(conditionId);

    // Get the date range for this market's data
    const rangeQuery = `
      SELECT
        min(${safeKeyColumn}) AS min_ts,
        max(${safeKeyColumn}) AS max_ts,
        count() AS row_count
      FROM ${safeDatabase}.${safeTable}
      WHERE ${safeConditionIdColumn} = '${safeConditionId}'
      FORMAT JSON
    `;

    const rangeResult = await this.executeQuery(rangeQuery);

    // Distinguish query failure from empty results
    if (!rangeResult.success) {
      console.error(
        `[Archive] Query failed for ${database}.${table} (condition_id: ${conditionId.slice(0, 20)}...): ${rangeResult.error}`
      );
      return {
        success: false,
        database,
        table,
        archiveType: "resolved",
        rowsArchived: 0,
        r2Path: "",
        error: rangeResult.error || "Query failed",
      };
    }

    if (!rangeResult.data?.[0]) {
      // No data to archive is not an error
      return {
        success: true,
        database,
        table,
        archiveType: "resolved",
        rowsArchived: 0,
        r2Path: "",
      };
    }

    const { min_ts, max_ts, row_count } = rangeResult.data[0];
    if (row_count === 0 || row_count === "0") {
      return {
        success: true,
        database,
        table,
        archiveType: "resolved",
        rowsArchived: 0,
        r2Path: "",
      };
    }

    // Group by month and archive each month separately
    const months = this.getMonthsBetween(new Date(min_ts), new Date(max_ts));
    let totalArchived = 0;
    let lastPath = "";

    for (const month of months) {
      const monthStart = `${month}-01`;
      const monthEnd = this.getMonthEnd(month);

      const query = `
        SELECT *
        FROM ${safeDatabase}.${safeTable}
        WHERE ${safeConditionIdColumn} = '${safeConditionId}'
          AND ${safeKeyColumn} >= '${monthStart}'
          AND ${safeKeyColumn} < '${monthEnd}'
      `;

      const r2Path = getArchivePath(database, table, "resolved", {
        conditionId,
        month,
      });

      const result = await this.exportAndUpload(query, r2Path);
      if (result.success) {
        totalArchived += result.rowsArchived;
        lastPath = r2Path;

        // Update manifest
        await this.updateManifest(database, table, {
          path: r2Path,
          rows: result.rowsArchived,
          minTs: monthStart,
          maxTs: monthEnd,
          archivedAt: new Date().toISOString(),
        });
      }
    }

    return {
      success: true,
      database,
      table,
      archiveType: "resolved",
      rowsArchived: totalArchived,
      r2Path: lastPath,
      minTs: min_ts,
      maxTs: max_ts,
    };
  }

  /**
   * Export query results to Parquet and upload to R2
   */
  private async exportAndUpload(
    query: string,
    r2Path: string
  ): Promise<{ success: boolean; rowsArchived: number; minTs?: string; maxTs?: string; error?: string }> {
    try {
      // Export as Parquet from ClickHouse
      const parquetQuery = `${query.trim().replace(/;?\s*$/, "")} FORMAT Parquet`;

      const url = new URL(this.env.CLICKHOUSE_URL);
      url.searchParams.set("query", parquetQuery);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ClickHouse export failed: ${response.status} - ${errorText}`);
      }

      const parquetData = await response.arrayBuffer();

      // Check if we got any data
      if (parquetData.byteLength === 0) {
        return { success: true, rowsArchived: 0 };
      }

      // Upload to R2
      await this.uploadToR2(r2Path, parquetData);

      // Get row count (approximate from Parquet header or query)
      const countQuery = `SELECT count() AS cnt FROM (${query.trim().replace(/;?\s*$/, "")}) FORMAT JSON`;
      const countResult = await this.executeQuery(countQuery);
      const rowCount = countResult.data?.[0]?.cnt || 0;

      console.log(`[Archive] Uploaded ${rowCount} rows to ${r2Path} (${parquetData.byteLength} bytes)`);

      return {
        success: true,
        rowsArchived: typeof rowCount === "string" ? parseInt(rowCount, 10) : rowCount,
      };
    } catch (error) {
      console.error(`[Archive] Export/upload failed for ${r2Path}:`, error);
      return {
        success: false,
        rowsArchived: 0,
        error: String(error),
      };
    }
  }

  /**
   * Upload data to R2
   */
  private async uploadToR2(key: string, data: ArrayBuffer): Promise<void> {
    const bucket = this.env.ARCHIVE_BUCKET as R2Bucket;
    await bucket.put(key, data, {
      httpMetadata: {
        contentType: "application/octet-stream",
      },
      customMetadata: {
        archivedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Update the manifest file for a table with optimistic locking.
   * Uses R2 etag-based conditional writes to prevent race conditions.
   */
  private async updateManifest(
    database: string,
    table: string,
    entry: ManifestEntry
  ): Promise<void> {
    const bucket = this.env.ARCHIVE_BUCKET as R2Bucket;
    const manifestPath = getManifestPath(database, table);

    for (let attempt = 0; attempt < MANIFEST_UPDATE_MAX_RETRIES; attempt++) {
      // Get existing manifest with etag for conditional write
      let manifest: TableManifest;
      let existingEtag: string | undefined;

      try {
        const existing = await bucket.get(manifestPath);
        if (existing) {
          manifest = await existing.json();
          existingEtag = existing.etag;
        } else {
          manifest = {
            database,
            table,
            lastUpdated: new Date().toISOString(),
            totalRows: 0,
            entries: [],
          };
        }
      } catch {
        manifest = {
          database,
          table,
          lastUpdated: new Date().toISOString(),
          totalRows: 0,
          entries: [],
        };
      }

      // Check for duplicate entry by path only (idempotency)
      // Don't include archivedAt in check - retried jobs have different timestamps
      const existingEntryIndex = manifest.entries.findIndex((e) => e.path === entry.path);
      if (existingEntryIndex >= 0) {
        console.log(`[Archive] Manifest entry already exists for ${entry.path}, skipping`);
        return;
      }

      // Add new entry
      manifest.entries.push(entry);
      manifest.totalRows += entry.rows;
      manifest.lastUpdated = new Date().toISOString();

      // Prepare conditional write options
      const putOptions: R2PutOptions = {
        httpMetadata: {
          contentType: "application/json",
        },
      };

      // If we have an existing etag, use conditional write to prevent race conditions
      if (existingEtag) {
        putOptions.onlyIf = { etagMatches: existingEtag };
      }

      try {
        const result = await bucket.put(manifestPath, JSON.stringify(manifest, null, 2), putOptions);

        // R2 returns null if the conditional write fails (etag mismatch)
        if (result === null) {
          console.log(`[Archive] Manifest etag mismatch, retrying (attempt ${attempt + 1})`);
          // Wait with exponential backoff before retry
          await new Promise((resolve) => setTimeout(resolve, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }

        // Success
        return;
      } catch (error) {
        // R2 may throw on conditional write failure
        if (attempt < MANIFEST_UPDATE_MAX_RETRIES - 1) {
          console.log(`[Archive] Manifest update failed, retrying (attempt ${attempt + 1}):`, error);
          await new Promise((resolve) => setTimeout(resolve, MANIFEST_RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to update manifest after ${MANIFEST_UPDATE_MAX_RETRIES} attempts`);
  }

  /**
   * Log archive operation to ClickHouse
   */
  private async logArchive(
    conditionId: string | null,
    archiveType: ArchiveType,
    tableName: string,
    result: ArchiveResult
  ): Promise<void> {
    const row = {
      condition_id: conditionId || "",
      archive_type: archiveType,
      table_name: tableName,
      r2_path: result.r2Path,
      rows_archived: result.rowsArchived,
      min_source_ts: result.minTs || new Date().toISOString(),
      max_source_ts: result.maxTs || new Date().toISOString(),
      archived_at: new Date().toISOString(),
      clickhouse_deleted: 0,
    };

    const url = new URL(this.env.CLICKHOUSE_URL);
    url.searchParams.set(
      "query",
      "INSERT INTO trading_data.archive_log FORMAT JSONEachRow"
    );

    try {
      await fetch(url.toString(), {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
          "Content-Type": "application/x-ndjson",
        },
        body: JSON.stringify(row),
      });
    } catch (error) {
      console.error("[Archive] Failed to log archive operation:", error);
    }
  }

  /**
   * Delete archived data from ClickHouse (after verification)
   * CRITICAL: Verifies that archived row count matches before deletion
   */
  async deleteArchivedData(
    database: string,
    table: string,
    conditions: { column: string; value: string }[]
  ): Promise<{ success: boolean; rowsDeleted: number; error?: string }> {
    // Validate identifiers
    const safeDatabase = safeIdentifier(database, "database");
    const safeTable = safeIdentifier(table, "table");

    // Build WHERE clause with escaped values
    const whereClauseParts = conditions.map((c) => {
      const safeColumn = safeIdentifier(c.column, "column");
      const safeValue = escapeString(c.value);
      return `${safeColumn} = '${safeValue}'`;
    });
    const whereClause = whereClauseParts.join(" AND ");

    // First, verify the data exists in R2 by checking manifest
    const bucket = this.env.ARCHIVE_BUCKET as R2Bucket;
    const manifestPath = getManifestPath(database, table);
    const manifestObj = await bucket.get(manifestPath);

    if (!manifestObj) {
      return {
        success: false,
        rowsDeleted: 0,
        error: "Manifest not found - cannot verify archive exists",
      };
    }

    // Parse manifest and verify archived row counts
    const manifest: TableManifest = await manifestObj.json();

    // Find the condition_id we're deleting (if applicable)
    const conditionIdCondition = conditions.find((c) => c.column === "condition_id");
    let archivedRowCount = 0;

    if (conditionIdCondition) {
      // Sum up all archived rows for this condition_id
      // Use path segment match to avoid substring false positives
      // Path format: trading_data/resolved/{condition_id}/{table}/{month}/data.parquet
      const conditionIdSegment = `/${conditionIdCondition.value}/`;
      archivedRowCount = manifest.entries
        .filter((e) => e.path.includes(conditionIdSegment))
        .reduce((sum, e) => sum + e.rows, 0);
    } else {
      // For non-condition_id deletions, sum all entries
      archivedRowCount = manifest.totalRows;
    }

    // Get row count in ClickHouse before delete
    const countQuery = `
      SELECT count() AS cnt FROM ${safeDatabase}.${safeTable}
      WHERE ${whereClause}
      FORMAT JSON
    `;
    const countResult = await this.executeQuery(countQuery);
    const clickhouseRowCount = countResult.data?.[0]?.cnt || 0;
    const rowCount = typeof clickhouseRowCount === "string" ? parseInt(clickhouseRowCount, 10) : clickhouseRowCount;

    // CRITICAL: Verify row counts match before deletion
    // Allow for small discrepancies (< 1%) due to timing/concurrent writes
    const tolerance = Math.max(10, Math.floor(archivedRowCount * 0.01));
    if (Math.abs(rowCount - archivedRowCount) > tolerance && archivedRowCount > 0) {
      return {
        success: false,
        rowsDeleted: 0,
        error: `Data verification failed: ClickHouse has ${rowCount} rows but archive has ${archivedRowCount} rows. Difference exceeds tolerance of ${tolerance}.`,
      };
    }

    console.log(`[Archive] Verified: ${rowCount} rows in ClickHouse, ${archivedRowCount} rows in archive`);

    // Execute lightweight delete
    const deleteQuery = `
      ALTER TABLE ${safeDatabase}.${safeTable}
      DELETE WHERE ${whereClause}
    `;

    const url = new URL(this.env.CLICKHOUSE_URL);
    url.searchParams.set("query", deleteQuery);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Delete failed: ${response.status} - ${errorText}`);
      }

      // Update archive_log to mark as deleted
      await this.markArchiveDeleted(conditions);

      console.log(`[Archive] Deleted ${rowCount} rows from ${safeDatabase}.${safeTable}`);

      return {
        success: true,
        rowsDeleted: rowCount,
      };
    } catch (error) {
      return {
        success: false,
        rowsDeleted: 0,
        error: String(error),
      };
    }
  }

  /**
   * Mark archive log entry as deleted from ClickHouse
   */
  private async markArchiveDeleted(
    conditions: { column: string; value: string }[]
  ): Promise<void> {
    const conditionId = conditions.find((c) => c.column === "condition_id")?.value;
    if (!conditionId) return;

    // Escape the condition_id to prevent SQL injection
    const safeConditionId = escapeString(conditionId);

    const updateQuery = `
      ALTER TABLE trading_data.archive_log
      UPDATE clickhouse_deleted = 1
      WHERE condition_id = '${safeConditionId}'
    `;

    const url = new URL(this.env.CLICKHOUSE_URL);
    url.searchParams.set("query", updateQuery);

    try {
      await fetch(url.toString(), {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
      });
    } catch (error) {
      console.error("[Archive] Failed to mark archive as deleted:", error);
    }
  }

  /**
   * Get markets ready for archival (end_date > 7 days ago, not yet archived)
   */
  async getArchivableMarkets(): Promise<string[]> {
    const query = `
      SELECT DISTINCT condition_id
      FROM ${DB_CONFIG.DATABASE}.market_metadata
      WHERE end_date < NOW() - INTERVAL 7 DAY
        AND end_date != ''
        AND condition_id NOT IN (
          SELECT DISTINCT condition_id
          FROM ${DB_CONFIG.DATABASE}.archive_log
          WHERE archive_type = 'resolved'
            AND clickhouse_deleted = 0
        )
      LIMIT 100
      FORMAT JSON
    `;

    const result = await this.executeQuery(query);
    return (result.data || []).map((r: { condition_id: string }) => r.condition_id);
  }

  /**
   * Execute a ClickHouse query and return JSON results
   */
  private async executeQuery(
    query: string
  ): Promise<{ success: boolean; data?: any[]; error?: string }> {
    const url = new URL(this.env.CLICKHOUSE_URL);
    url.searchParams.set("query", query);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "X-ClickHouse-User": this.env.CLICKHOUSE_USER,
          "X-ClickHouse-Key": this.env.CLICKHOUSE_TOKEN,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: errorText };
      }

      const result = (await response.json()) as { data: any[] };
      return { success: true, data: result.data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get current Polygon block number for block_range cutoff calculation
   */
  private async getCurrentBlockCutoff(): Promise<number> {
    // Try to get cached block number, or use a reasonable default
    try {
      const cached = await this.env.MARKET_CACHE.get("polygon_block_number");
      if (cached) {
        const blockNumber = parseInt(cached, 10);
        return calculateBlockCutoff(blockNumber, 90);
      }
    } catch {
      // Fall through to default
    }

    // Default: assume current block is ~70M (as of late 2024)
    // This should be updated periodically via a separate job
    const estimatedCurrentBlock = 70000000;
    return calculateBlockCutoff(estimatedCurrentBlock, 90);
  }

  /**
   * Get YYYY-MM format from a date
   */
  private getMonthFromDate(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /**
   * Get all months between two dates
   */
  private getMonthsBetween(start: Date, end: Date): string[] {
    const months: string[] = [];
    const current = new Date(start);
    current.setUTCDate(1);

    while (current <= end) {
      months.push(this.getMonthFromDate(current));
      current.setUTCMonth(current.getUTCMonth() + 1);
    }

    return months;
  }

  /**
   * Get the end of a month in ISO format
   */
  private getMonthEnd(month: string): string {
    const [year, monthNum] = month.split("-").map(Number);
    const nextMonth = new Date(Date.UTC(year, monthNum, 1));
    return nextMonth.toISOString().split("T")[0];
  }
}

/**
 * Process an archive job from the queue
 */
export async function processArchiveJob(
  job: ArchiveJob,
  env: Env
): Promise<ArchiveResult[]> {
  const service = new ArchiveService(env);

  if (job.type === "resolved" && job.conditionId) {
    return service.archiveResolvedMarket(job.conditionId);
  }

  if (job.type === "aged" && job.database && job.table) {
    const cutoffDate = job.cutoffDate
      ? new Date(job.cutoffDate)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await service.archiveAgedTable(
      job.database,
      job.table,
      cutoffDate,
      job.month
    );
    return [result];
  }

  console.error("[Archive] Invalid archive job:", job);
  return [];
}
