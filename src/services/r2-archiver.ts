// src/services/r2-archiver.ts
// Archives orderbook snapshots to R2 before ClickHouse TTL expires

import type { Env } from "../types";

interface ArchiveResult {
  date: string;
  assetsArchived: number;
  bytesWritten: number;
  filesCreated: string[];
}

/**
 * R2 Archiver for orderbook cold storage
 *
 * Exports data from ClickHouse that's about to expire (89 days old)
 * and writes to R2 as compressed NDJSON (Parquet-convertible format).
 *
 * File structure: archive/{YYYY}/{MM}/{DD}/{asset_id}.ndjson.gz
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
   * Archive snapshots from a specific date (defaults to 89 days ago)
   */
  async archiveDate(targetDate?: Date): Promise<ArchiveResult> {
    // Default to 89 days ago (1 day before TTL expires)
    const archiveDate = targetDate ?? new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    const dateStr = archiveDate.toISOString().split("T")[0]; // YYYY-MM-DD
    const [year, month, day] = dateStr.split("-");

    console.log(`[R2Archiver] Starting archive for ${dateStr}`);

    // Get distinct assets for this date
    const assets = await this.getAssetsForDate(dateStr);
    console.log(`[R2Archiver] Found ${assets.length} assets to archive`);

    if (assets.length === 0) {
      return {
        date: dateStr,
        assetsArchived: 0,
        bytesWritten: 0,
        filesCreated: [],
      };
    }

    let totalBytes = 0;
    const filesCreated: string[] = [];

    // Archive each asset separately for better queryability
    for (const assetId of assets) {
      const { bytes, key } = await this.archiveAsset(assetId, dateStr, year, month, day);
      totalBytes += bytes;
      if (key) filesCreated.push(key);
    }

    console.log(`[R2Archiver] Completed: ${filesCreated.length} files, ${totalBytes} bytes`);

    return {
      date: dateStr,
      assetsArchived: assets.length,
      bytesWritten: totalBytes,
      filesCreated,
    };
  }

  private async getAssetsForDate(dateStr: string): Promise<string[]> {
    const query = `
      SELECT DISTINCT asset_id
      FROM polymarket.ob_snapshots
      WHERE toDate(source_ts) = '${dateStr}'
      FORMAT JSONEachRow
    `;

    const response = await fetch(`${this.baseUrl}/?query=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      console.error(`[R2Archiver] Failed to get assets: ${await response.text()}`);
      return [];
    }

    const text = await response.text();
    if (!text.trim()) return [];

    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).asset_id);
  }

  private async archiveAsset(
    assetId: string,
    dateStr: string,
    year: string,
    month: string,
    day: string
  ): Promise<{ bytes: number; key: string | null }> {
    // Query all snapshots for this asset on this date
    const query = `
      SELECT
        asset_id,
        condition_id,
        source_ts,
        ingestion_ts,
        book_hash,
        bid_prices,
        bid_sizes,
        ask_prices,
        ask_sizes,
        best_bid,
        best_ask,
        mid_price,
        spread,
        spread_bps,
        tick_size,
        is_resync,
        sequence_number,
        total_bid_depth,
        total_ask_depth,
        book_imbalance
      FROM polymarket.ob_snapshots
      WHERE asset_id = '${assetId}' AND toDate(source_ts) = '${dateStr}'
      ORDER BY source_ts
      FORMAT JSONEachRow
    `;

    const response = await fetch(`${this.baseUrl}/?query=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      console.error(`[R2Archiver] Failed to fetch ${assetId}: ${await response.text()}`);
      return { bytes: 0, key: null };
    }

    const ndjsonData = await response.text();
    if (!ndjsonData.trim()) {
      return { bytes: 0, key: null };
    }

    // Compress with gzip
    const encoder = new TextEncoder();
    const data = encoder.encode(ndjsonData);
    const compressed = await this.gzipCompress(data);

    // Write to R2
    const key = `archive/${year}/${month}/${day}/${assetId}.ndjson.gz`;

    await this.env.ORDERBOOK_STORAGE.put(key, compressed, {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        assetId,
        date: dateStr,
        rowCount: String(ndjsonData.trim().split("\n").length),
        uncompressedSize: String(data.byteLength),
      },
    });

    console.log(`[R2Archiver] Wrote ${key} (${compressed.byteLength} bytes compressed)`);

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

    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }

  /**
   * List archived dates
   */
  async listArchives(prefix?: string): Promise<string[]> {
    const listed = await this.env.ORDERBOOK_STORAGE.list({
      prefix: prefix ?? "archive/",
      limit: 1000,
    });

    return listed.objects.map((obj) => obj.key);
  }

  /**
   * Read archived data for an asset on a specific date
   */
  async readArchive(assetId: string, dateStr: string): Promise<string | null> {
    const [year, month, day] = dateStr.split("-");
    const key = `archive/${year}/${month}/${day}/${assetId}.ndjson.gz`;

    const object = await this.env.ORDERBOOK_STORAGE.get(key);
    if (!object) return null;

    // Decompress
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

    const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
    const reader = decompressedStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }
}
