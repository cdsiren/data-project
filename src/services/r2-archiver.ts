// src/services/r2-archiver.ts
// Archives time-series data from ClickHouse to R2 before TTL expires

import type { Env } from "../types";

interface TableArchiveConfig {
  table: string;
  partitionKey: string;
  dateColumn: string;
  selectExpr?: string; // Custom SELECT expression, defaults to "*"
}

const ARCHIVE_CONFIGS: TableArchiveConfig[] = [
  {
    table: "ob_snapshots",
    partitionKey: "asset_id",
    dateColumn: "source_ts",
  },
  {
    table: "trades",
    partitionKey: "token_id",
    dateColumn: "timestamp",
  },
  {
    table: "makers",
    partitionKey: "token_id",
    dateColumn: "timestamp",
  },
  {
    table: "takers",
    partitionKey: "token_id",
    dateColumn: "timestamp",
  },
  {
    table: "markets",
    partitionKey: "token_id",
    dateColumn: "timestamp",
    // Finalize aggregate functions for JSON export
    selectExpr:
      "* EXCEPT(unique_makers, unique_takers), finalizeAggregation(unique_makers) as unique_makers_count, finalizeAggregation(unique_takers) as unique_takers_count",
  },
];

interface TableArchiveResult {
  table: string;
  date: string;
  partitionsArchived: number;
  bytesWritten: number;
  filesCreated: string[];
}

interface ArchiveAllResult {
  date: string;
  tables: TableArchiveResult[];
  totalBytesWritten: number;
  totalFilesCreated: number;
}

interface ArchiveResult {
  date: string;
  assetsArchived: number;
  bytesWritten: number;
  filesCreated: string[];
}

/**
 * R2 Archiver for ClickHouse cold storage
 *
 * Exports data from ClickHouse that's about to expire (89 days old)
 * and writes to R2 as compressed NDJSON.
 *
 * File structure: archive/{table}/{YYYY}/{MM}/{DD}/{partition_value}.ndjson.gz
 */
export class R2Archiver {
  private baseUrl: string;
  private headers: HeadersInit;

  constructor(private env: Env) {
    this.baseUrl = env.CLICKHOUSE_URL;
    this.headers = {
      Authorization: `Bearer ${env.CLICKHOUSE_TOKEN}`,
      "Content-Type": "text/plain",
    };
  }

  /**
   * Archive all configured tables for a specific date (defaults to 89 days ago)
   */
  async archiveAll(targetDate?: Date): Promise<ArchiveAllResult> {
    const archiveDate =
      targetDate ?? new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    const dateStr = archiveDate.toISOString().split("T")[0];

    console.log(`[R2Archiver] Starting archiveAll for ${dateStr}`);

    const tableResults: TableArchiveResult[] = [];
    let totalBytes = 0;
    let totalFiles = 0;

    for (const config of ARCHIVE_CONFIGS) {
      const result = await this.archiveTable(config, dateStr);
      tableResults.push(result);
      totalBytes += result.bytesWritten;
      totalFiles += result.filesCreated.length;
    }

    console.log(
      `[R2Archiver] archiveAll complete: ${totalFiles} files, ${totalBytes} bytes across ${tableResults.length} tables`
    );

    return {
      date: dateStr,
      tables: tableResults,
      totalBytesWritten: totalBytes,
      totalFilesCreated: totalFiles,
    };
  }

  /**
   * Archive a single table for a specific date
   */
  async archiveTable(
    config: TableArchiveConfig,
    dateStr: string
  ): Promise<TableArchiveResult> {
    const [year, month, day] = dateStr.split("-");

    console.log(`[R2Archiver] Archiving ${config.table} for ${dateStr}`);

    const partitions = await this.getPartitionsForDate(config, dateStr);
    console.log(
      `[R2Archiver] Found ${partitions.length} partitions for ${config.table}`
    );

    if (partitions.length === 0) {
      return {
        table: config.table,
        date: dateStr,
        partitionsArchived: 0,
        bytesWritten: 0,
        filesCreated: [],
      };
    }

    let totalBytes = 0;
    const filesCreated: string[] = [];

    for (const partitionValue of partitions) {
      const { bytes, key } = await this.archivePartition(
        config,
        partitionValue,
        dateStr,
        year,
        month,
        day
      );
      totalBytes += bytes;
      if (key) filesCreated.push(key);
    }

    console.log(
      `[R2Archiver] ${config.table}: ${filesCreated.length} files, ${totalBytes} bytes`
    );

    return {
      table: config.table,
      date: dateStr,
      partitionsArchived: partitions.length,
      bytesWritten: totalBytes,
      filesCreated,
    };
  }

  /**
   * Archive snapshots from a specific date (backwards compatibility)
   * Only archives ob_snapshots table
   */
  async archiveDate(targetDate?: Date): Promise<ArchiveResult> {
    const archiveDate =
      targetDate ?? new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    const dateStr = archiveDate.toISOString().split("T")[0];

    const config = ARCHIVE_CONFIGS.find((c) => c.table === "ob_snapshots");
    if (!config) {
      return {
        date: dateStr,
        assetsArchived: 0,
        bytesWritten: 0,
        filesCreated: [],
      };
    }

    const result = await this.archiveTable(config, dateStr);

    return {
      date: result.date,
      assetsArchived: result.partitionsArchived,
      bytesWritten: result.bytesWritten,
      filesCreated: result.filesCreated,
    };
  }

  private async getPartitionsForDate(
    config: TableArchiveConfig,
    dateStr: string
  ): Promise<string[]> {
    const query = `
      SELECT DISTINCT ${config.partitionKey}
      FROM polymarket.${config.table}
      WHERE toDate(${config.dateColumn}) = '${dateStr}'
      FORMAT JSONEachRow
    `;

    const response = await fetch(
      `${this.baseUrl}/?query=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: this.headers,
      }
    );

    if (!response.ok) {
      console.error(
        `[R2Archiver] Failed to get partitions for ${config.table}: ${await response.text()}`
      );
      return [];
    }

    const text = await response.text();
    if (!text.trim()) return [];

    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)[config.partitionKey]);
  }

  private async archivePartition(
    config: TableArchiveConfig,
    partitionValue: string,
    dateStr: string,
    year: string,
    month: string,
    day: string
  ): Promise<{ bytes: number; key: string | null }> {
    const selectExpr = config.selectExpr ?? "*";
    const query = `
      SELECT ${selectExpr}
      FROM polymarket.${config.table}
      WHERE ${config.partitionKey} = '${partitionValue}' AND toDate(${config.dateColumn}) = '${dateStr}'
      ORDER BY ${config.dateColumn}
      FORMAT JSONEachRow
    `;

    const response = await fetch(
      `${this.baseUrl}/?query=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: this.headers,
      }
    );

    if (!response.ok) {
      console.error(
        `[R2Archiver] Failed to fetch ${config.table}/${partitionValue}: ${await response.text()}`
      );
      return { bytes: 0, key: null };
    }

    const ndjsonData = await response.text();
    if (!ndjsonData.trim()) {
      return { bytes: 0, key: null };
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(ndjsonData);
    const compressed = await this.gzipCompress(data);

    const key = `archive/${config.table}/${year}/${month}/${day}/${partitionValue}.ndjson.gz`;

    await this.env.ORDERBOOK_STORAGE.put(key, compressed, {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        table: config.table,
        partitionKey: config.partitionKey,
        partitionValue,
        date: dateStr,
        rowCount: String(ndjsonData.trim().split("\n").length),
        uncompressedSize: String(data.byteLength),
      },
    });

    console.log(
      `[R2Archiver] Wrote ${key} (${compressed.byteLength} bytes compressed)`
    );

    return { bytes: compressed.byteLength, key };
  }

  private async gzipCompress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));
    const reader = compressedStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0
    );
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }

  /**
   * List archived files
   */
  async listArchives(prefix?: string): Promise<string[]> {
    const listed = await this.env.ORDERBOOK_STORAGE.list({
      prefix: prefix ?? "archive/",
      limit: 1000,
    });

    return listed.objects.map((obj) => obj.key);
  }

  /**
   * Read archived data for a partition on a specific date
   */
  async readArchive(
    table: string,
    partitionValue: string,
    dateStr: string
  ): Promise<string | null> {
    const [year, month, day] = dateStr.split("-");
    const key = `archive/${table}/${year}/${month}/${day}/${partitionValue}.ndjson.gz`;

    const object = await this.env.ORDERBOOK_STORAGE.get(key);
    if (!object) return null;

    const compressed = await object.arrayBuffer();
    const decompressed = await this.gzipDecompress(new Uint8Array(compressed));

    return new TextDecoder().decode(decompressed);
  }

  private async gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const decompressedStream = stream.pipeThrough(
      new DecompressionStream("gzip")
    );
    const reader = decompressedStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0
    );
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }
}
