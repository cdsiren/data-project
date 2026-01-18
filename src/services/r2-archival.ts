// src/services/r2-archival.ts
// Archives ClickHouse data older than retention period to R2 cold storage as Parquet files

import type { Env } from "../types";
import { DB_CONFIG, ARCHIVABLE_TABLES } from "../config/database";

export interface ArchivalJob {
  table_name: string;
  partition_month: string;
  timestamp_column: string;
}

interface ArchivalResult {
  table: string;
  partition: string;
  rows_archived: number;
  file_size_bytes: number;
  r2_path: string;
  duration_ms: number;
}

export class R2ArchivalService {
  private chUrl: string;
  private chHeaders: HeadersInit;
  private r2: R2Bucket;
  private retentionDays: number;

  constructor(env: Env) {
    this.chUrl = env.CLICKHOUSE_URL;
    this.chHeaders = {
      "X-ClickHouse-User": env.CLICKHOUSE_USER,
      "X-ClickHouse-Key": env.CLICKHOUSE_TOKEN,
      "Content-Type": "text/plain",
    };
    this.r2 = env.ARCHIVE_BUCKET;
    this.retentionDays = parseInt(env.ARCHIVE_RETENTION_DAYS) || 180;
  }

  async runScheduledArchival(): Promise<ArchivalResult[]> {
    const results: ArchivalResult[] = [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    const cutoffMonth = cutoffDate.toISOString().slice(0, 7);

    console.log(`[Archival] Starting scheduled archival. Cutoff: ${cutoffMonth}`);

    for (const table of ARCHIVABLE_TABLES) {
      try {
        const fullTableName = `${DB_CONFIG.DATABASE}.${table.name}`;
        const partitions = await this.getPartitionsToArchive(
          DB_CONFIG.DATABASE,
          table.name,
          cutoffMonth
        );

        console.log(`[Archival] ${fullTableName}: ${partitions.length} partitions to archive`);

        for (const partition of partitions) {
          const result = await this.archivePartition({
            table_name: fullTableName,
            partition_month: partition,
            timestamp_column: table.ts_col,
          });
          if (result) {
            results.push(result);
          }
        }
      } catch (error) {
        console.error(`[Archival] Error processing ${table.name}:`, error);
      }
    }

    console.log(`[Archival] Completed. Archived ${results.length} partitions.`);
    return results;
  }

  private async getPartitionsToArchive(
    database: string,
    table: string,
    cutoffMonth: string
  ): Promise<string[]> {
    const cutoffPartition = cutoffMonth.replace("-", "");

    // Use parameterized query to prevent SQL injection
    const query = `
      SELECT DISTINCT partition
      FROM system.parts
      WHERE database = {db:String}
        AND table = {tbl:String}
        AND active = 1
        AND partition < {cutoff:String}
      ORDER BY partition ASC
    `;

    const params = new URLSearchParams({
      query: query + " FORMAT JSONEachRow",
      param_db: database,
      param_tbl: table,
      param_cutoff: cutoffPartition,
    });

    const response = await fetch(`${this.chUrl}/?${params.toString()}`, {
      method: "GET",
      headers: this.chHeaders,
    });

    if (!response.ok) {
      throw new Error(`Failed to get partitions: ${await response.text()}`);
    }

    const text = await response.text();
    if (!text.trim()) return [];

    return text
      .trim()
      .split("\n")
      .map((line) => {
        const parsed = JSON.parse(line) as { partition: string };
        const p = parsed.partition;
        return `${p.slice(0, 4)}-${p.slice(4, 6)}`;
      });
  }

  async archivePartition(job: ArchivalJob): Promise<ArchivalResult | null> {
    const startTime = Date.now();
    const partitionFilter = job.partition_month.replace("-", "");

    console.log(`[Archival] Archiving ${job.table_name} partition ${job.partition_month}`);

    // Check if already archived
    const alreadyArchived = await this.isPartitionArchived(
      job.table_name,
      job.partition_month
    );
    if (alreadyArchived) {
      console.log(`[Archival] ${job.table_name}/${job.partition_month} already archived, skipping`);
      return null;
    }

    // Get row count first using parameterized query
    const countQuery = `
      SELECT count() as cnt
      FROM ${job.table_name}
      WHERE toYYYYMM(${job.timestamp_column}) = {partition:UInt32}
    `;
    const countParams = new URLSearchParams({
      query: countQuery + " FORMAT JSON",
      param_partition: partitionFilter,
    });

    const countResponse = await fetch(`${this.chUrl}/?${countParams.toString()}`, {
      method: "GET",
      headers: this.chHeaders,
    });

    if (!countResponse.ok) {
      throw new Error(`Failed to count rows: ${await countResponse.text()}`);
    }

    const countData = (await countResponse.json()) as {
      data: Array<{ cnt: string }>;
    };
    const rowCount = parseInt(countData.data[0].cnt);

    if (rowCount === 0) {
      console.log(`[Archival] ${job.table_name}/${job.partition_month} has 0 rows, skipping`);
      return null;
    }

    // Export to Parquet using parameterized query
    const exportQuery = `
      SELECT *
      FROM ${job.table_name}
      WHERE toYYYYMM(${job.timestamp_column}) = {partition:UInt32}
      FORMAT Parquet
    `;
    const exportParams = new URLSearchParams({
      query: exportQuery,
      param_partition: partitionFilter,
    });

    const exportResponse = await fetch(`${this.chUrl}/?${exportParams.toString()}`, {
      method: "GET",
      headers: this.chHeaders,
    });

    if (!exportResponse.ok) {
      throw new Error(`Failed to export: ${await exportResponse.text()}`);
    }

    const parquetData = await exportResponse.arrayBuffer();
    const fileSize = parquetData.byteLength;

    // Upload to R2
    const tableName = job.table_name.split(".").pop() || job.table_name;
    const r2Path = `archive/${tableName}/${job.partition_month}/data.parquet`;

    await this.r2.put(r2Path, parquetData, {
      httpMetadata: { contentType: "application/vnd.apache.parquet" },
      customMetadata: {
        table: job.table_name,
        partition: job.partition_month,
        row_count: rowCount.toString(),
        exported_at: new Date().toISOString(),
      },
    });

    console.log(
      `[Archival] Uploaded ${r2Path} (${rowCount} rows, ${(fileSize / 1024 / 1024).toFixed(2)} MB)`
    );

    // Record in manifest
    await this.recordArchiveManifest(
      job.table_name,
      job.partition_month,
      r2Path,
      rowCount,
      fileSize
    );

    // Delete from ClickHouse
    await this.deletePartition(job.table_name, partitionFilter);

    return {
      table: job.table_name,
      partition: job.partition_month,
      rows_archived: rowCount,
      file_size_bytes: fileSize,
      r2_path: r2Path,
      duration_ms: Date.now() - startTime,
    };
  }

  private async isPartitionArchived(
    tableName: string,
    partitionMonth: string
  ): Promise<boolean> {
    // Use parameterized query
    const query = `
      SELECT count() as cnt
      FROM ${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES.ARCHIVE_MANIFEST}
      WHERE table_name = {tbl:String}
        AND partition_month = {partition:String}
    `;
    const params = new URLSearchParams({
      query: query + " FORMAT JSON",
      param_tbl: tableName,
      param_partition: partitionMonth,
    });

    try {
      const response = await fetch(`${this.chUrl}/?${params.toString()}`, {
        method: "GET",
        headers: this.chHeaders,
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { data: Array<{ cnt: string }> };
      return parseInt(data.data[0].cnt) > 0;
    } catch {
      return false;
    }
  }

  private async recordArchiveManifest(
    tableName: string,
    partitionMonth: string,
    r2Path: string,
    rowCount: number,
    fileSize: number
  ): Promise<void> {
    const row = {
      table_name: tableName,
      partition_month: partitionMonth,
      r2_path: r2Path,
      row_count: rowCount,
      file_size_bytes: fileSize,
      checksum: "",
    };
    const response = await fetch(
      `${this.chUrl}/?query=INSERT INTO ${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES.ARCHIVE_MANIFEST} FORMAT JSONEachRow`,
      { method: "POST", headers: this.chHeaders, body: JSON.stringify(row) }
    );
    if (!response.ok) {
      console.error(`[Archival] Failed to record manifest: ${await response.text()}`);
    }
  }

  private async deletePartition(
    tableName: string,
    partitionFilter: string
  ): Promise<void> {
    // Note: ALTER TABLE DROP PARTITION cannot use parameterized queries for partition value
    // The partition filter is derived from our internal cutoff date calculation, not user input
    const query = `ALTER TABLE ${tableName} DROP PARTITION '${partitionFilter}'`;
    const response = await fetch(
      `${this.chUrl}/?query=${encodeURIComponent(query)}`,
      { method: "POST", headers: this.chHeaders }
    );
    if (!response.ok) {
      console.error(`[Archival] Failed to drop partition: ${await response.text()}`);
    } else {
      console.log(`[Archival] Dropped partition ${partitionFilter} from ${tableName}`);
    }
  }

  async listArchivedPartitions(tableName?: string): Promise<
    Array<{
      table_name: string;
      partition_month: string;
      row_count: number;
      file_size_bytes: number;
      archived_at: string;
    }>
  > {
    let query = `
      SELECT table_name, partition_month, row_count, file_size_bytes, archived_at
      FROM ${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES.ARCHIVE_MANIFEST}
    `;

    const params = new URLSearchParams();

    if (tableName) {
      query += ` WHERE table_name = {tbl:String}`;
      params.set("param_tbl", tableName);
    }
    query += " ORDER BY table_name, partition_month";
    params.set("query", query + " FORMAT JSON");

    const response = await fetch(`${this.chUrl}/?${params.toString()}`, {
      method: "GET",
      headers: this.chHeaders,
    });

    if (!response.ok) {
      throw new Error(`Failed to list archives: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      data: Array<{
        table_name: string;
        partition_month: string;
        row_count: string;
        file_size_bytes: string;
        archived_at: string;
      }>;
    };

    return data.data.map((row) => ({
      table_name: row.table_name,
      partition_month: row.partition_month,
      row_count: parseInt(row.row_count),
      file_size_bytes: parseInt(row.file_size_bytes),
      archived_at: row.archived_at,
    }));
  }
}
