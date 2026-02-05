// src/services/archive-query.ts
// Query routing service for hot (ClickHouse) and cold (R2) data access

import type { Env } from "../types";
import type { DataTier, ExportFormat } from "../schemas/common";
import { TIER_LIMITS } from "../schemas/common";
import { DB_CONFIG, getManifestPath } from "../config/database";

// ============================================================
// SQL Injection Protection
// ============================================================

/**
 * Escape a string value for safe use in ClickHouse SQL queries.
 */
function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Validate that a value is a safe identifier.
 */
function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

/**
 * Validate and return a safe identifier, throwing if invalid.
 */
function safeIdentifier(value: string, type: string): string {
  if (!isValidIdentifier(value)) {
    throw new Error(`Invalid ${type}: ${value}`);
  }
  return value;
}

// ============================================================
// Manifest Types (for R2 archive tracking)
// ============================================================

export interface ManifestEntry {
  path: string;
  rows: number;
  minTs: string;
  maxTs: string;
  archivedAt: string;
  sizeBytes?: number;
}

export interface TableManifest {
  database: string;
  table: string;
  lastUpdated: string;
  totalRows: number;
  entries: ManifestEntry[];
}

// ============================================================
// Types
// ============================================================

export interface QueryOptions {
  assetId?: string;
  conditionId?: string;
  startDate: Date;
  endDate: Date;
  tier: DataTier;
  table?: string;
  limit?: number;
}

export interface QueryPlan {
  type: "hot" | "cold" | "hybrid";
  hotRange?: { start: Date; end: Date };
  coldRange?: { start: Date; end: Date };
  coldPaths?: string[];
}

export interface QueryResult {
  data: any[];
  rowCount: number;
  source: "hot" | "cold" | "hybrid";
  coldFilesUsed?: string[];
}

export interface BulkExportResult {
  format: ExportFormat;
  files: Array<{ path: string; url: string; rows?: number }>;
  expiresIn: number;
  queryExample: string;
}

// ============================================================
// Archive Query Service
// ============================================================

export class ArchiveQueryService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Execute a query, routing to hot (ClickHouse) or cold (R2) data as needed
   */
  async execute(options: QueryOptions): Promise<QueryResult> {
    const { tier, startDate, endDate } = options;

    // Check tier limits
    const tierLimits = TIER_LIMITS[tier];
    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const requestedDays = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay);

    if (tierLimits.historicalDays !== Infinity && requestedDays > tierLimits.historicalDays) {
      throw new Error(
        `Your ${tier} tier allows ${tierLimits.historicalDays} days of historical data. Requested: ${requestedDays} days.`
      );
    }

    // Plan the query
    const plan = await this.planQuery(options);

    // Execute based on plan
    switch (plan.type) {
      case "hot":
        return this.queryHot(options);
      case "cold":
        return this.queryCold(options, plan.coldPaths || []);
      case "hybrid":
        return this.queryHybrid(options, plan);
      default:
        throw new Error(`Unknown query plan type: ${plan.type}`);
    }
  }

  /**
   * Plan query routing based on archive status
   */
  private async planQuery(options: QueryOptions): Promise<QueryPlan> {
    const { conditionId, startDate, endDate } = options;
    const table = options.table || "ob_bbo";

    // Check what data has been archived
    const archiveRanges = await this.getArchiveRanges(table, conditionId);

    // If no archives exist, all data is hot
    if (archiveRanges.length === 0) {
      return { type: "hot" };
    }

    // Determine if requested range overlaps with archived data
    const archivedStart = new Date(Math.min(...archiveRanges.map((r) => new Date(r.minTs).getTime())));
    const archivedEnd = new Date(Math.max(...archiveRanges.map((r) => new Date(r.maxTs).getTime())));

    // Check what's in archive vs what's in hot storage
    if (startDate >= archivedEnd) {
      // Request is entirely in hot storage (recent data)
      return { type: "hot" };
    }

    if (endDate <= archivedStart) {
      // This shouldn't happen as archived data is older
      return { type: "hot" };
    }

    // Check if request overlaps archive boundary
    const archiveBoundary = await this.getArchiveBoundary();

    if (startDate >= archiveBoundary) {
      // All requested data is still in ClickHouse
      return { type: "hot" };
    }

    if (endDate <= archiveBoundary) {
      // All requested data is in R2
      const coldPaths = archiveRanges
        .filter((r) => {
          const rStart = new Date(r.minTs);
          const rEnd = new Date(r.maxTs);
          return rStart <= endDate && rEnd >= startDate;
        })
        .map((r) => r.path);

      return { type: "cold", coldPaths };
    }

    // Hybrid: spans both hot and cold
    const coldPaths = archiveRanges
      .filter((r) => new Date(r.maxTs) <= archiveBoundary)
      .map((r) => r.path);

    return {
      type: "hybrid",
      hotRange: { start: archiveBoundary, end: endDate },
      coldRange: { start: startDate, end: archiveBoundary },
      coldPaths,
    };
  }

  /**
   * Query hot data from ClickHouse
   */
  private async queryHot(options: QueryOptions): Promise<QueryResult> {
    const { assetId, conditionId, startDate, endDate, limit = 100000 } = options;
    const table = options.table || "ob_bbo";

    // Validate identifiers and escape user input
    const safeTable = safeIdentifier(table, "table");

    // Dates are safe (toISOString produces predictable format)
    let whereClause = `source_ts BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'`;
    if (assetId) {
      whereClause += ` AND asset_id = '${escapeString(assetId)}'`;
    }
    if (conditionId) {
      whereClause += ` AND condition_id = '${escapeString(conditionId)}'`;
    }

    // Ensure limit is a safe number
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000000);

    const query = `
      SELECT *
      FROM ${DB_CONFIG.DATABASE}.${safeTable}
      WHERE ${whereClause}
      ORDER BY source_ts ASC
      LIMIT ${safeLimit}
      FORMAT JSON
    `;

    const result = await this.executeClickHouseQuery(query);

    return {
      data: result.data || [],
      rowCount: result.data?.length || 0,
      source: "hot",
    };
  }

  /**
   * Query cold data from R2 via ClickHouse S3() function.
   *
   * This uses ClickHouse's native S3 function to query Parquet files directly from R2.
   * Requires R2 S3 API credentials to be configured in environment:
   * - R2_ACCESS_KEY_ID: R2 API token access key
   * - R2_SECRET_ACCESS_KEY: R2 API token secret
   * - R2_ACCOUNT_ID: Cloudflare account ID (for R2 endpoint URL)
   *
   * Generate R2 API tokens at: https://dash.cloudflare.com/?to=/:account/r2/api-tokens
   */
  private async queryCold(
    options: QueryOptions,
    paths: string[]
  ): Promise<QueryResult> {
    if (paths.length === 0) {
      return { data: [], rowCount: 0, source: "cold", coldFilesUsed: [] };
    }

    const { assetId, conditionId, startDate, endDate, limit = 100000 } = options;

    // Check for R2 S3 credentials
    const r2AccessKeyId = this.env.R2_ACCESS_KEY_ID;
    const r2SecretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    const r2AccountId = this.env.R2_ACCOUNT_ID;

    if (!r2AccessKeyId || !r2SecretAccessKey || !r2AccountId) {
      console.warn(
        "[ArchiveQuery] Cold data query requires R2 S3 credentials. " +
        "Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID environment variables."
      );
      // Return empty with metadata about what files would be queried
      return {
        data: [],
        rowCount: 0,
        source: "cold",
        coldFilesUsed: paths,
      };
    }

    // Build WHERE clause for filtering within Parquet files
    let whereClause = `source_ts BETWEEN '${startDate.toISOString()}' AND '${endDate.toISOString()}'`;
    if (assetId) {
      whereClause += ` AND asset_id = '${escapeString(assetId)}'`;
    }
    if (conditionId) {
      whereClause += ` AND condition_id = '${escapeString(conditionId)}'`;
    }

    // Ensure limit is safe
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000000);

    // R2 S3-compatible endpoint
    const r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
    const bucketName = "trading-data-archive";

    // Build UNION ALL query for multiple Parquet files
    // ClickHouse's s3() function can query Parquet files directly
    const s3Queries = paths.map((path) => {
      const s3Url = `${r2Endpoint}/${bucketName}/${path}`;
      // Escape the URL and credentials for SQL
      const safeUrl = escapeString(s3Url);
      const safeAccessKey = escapeString(r2AccessKeyId);
      const safeSecretKey = escapeString(r2SecretAccessKey);

      return `SELECT * FROM s3('${safeUrl}', '${safeAccessKey}', '${safeSecretKey}', 'Parquet')`;
    });

    // Combine into single query with filtering
    const query = `
      SELECT *
      FROM (
        ${s3Queries.join(" UNION ALL ")}
      )
      WHERE ${whereClause}
      ORDER BY source_ts ASC
      LIMIT ${safeLimit}
      FORMAT JSON
    `;

    try {
      const result = await this.executeClickHouseQuery(query);

      if (result.error) {
        console.error(`[ArchiveQuery] Cold data query failed: ${result.error}`);
        return {
          data: [],
          rowCount: 0,
          source: "cold",
          coldFilesUsed: paths,
        };
      }

      console.log(
        `[ArchiveQuery] Retrieved ${result.data?.length || 0} rows from ${paths.length} cold files`
      );

      return {
        data: result.data || [],
        rowCount: result.data?.length || 0,
        source: "cold",
        coldFilesUsed: paths,
      };
    } catch (error) {
      console.error(`[ArchiveQuery] Cold data query error:`, error);
      return {
        data: [],
        rowCount: 0,
        source: "cold",
        coldFilesUsed: paths,
      };
    }
  }

  /**
   * Query hybrid - both hot and cold data
   */
  private async queryHybrid(
    options: QueryOptions,
    plan: QueryPlan
  ): Promise<QueryResult> {
    const [hotResult, coldResult] = await Promise.all([
      plan.hotRange
        ? this.queryHot({
            ...options,
            startDate: plan.hotRange.start,
            endDate: plan.hotRange.end,
          })
        : Promise.resolve({ data: [], rowCount: 0, source: "hot" as const }),
      plan.coldPaths && plan.coldPaths.length > 0
        ? this.queryCold(
            {
              ...options,
              startDate: plan.coldRange!.start,
              endDate: plan.coldRange!.end,
            },
            plan.coldPaths
          )
        : Promise.resolve({ data: [], rowCount: 0, source: "cold" as const, coldFilesUsed: [] }),
    ]);

    // Merge results (cold data first, then hot)
    const mergedData = [...coldResult.data, ...hotResult.data];

    // Sort by timestamp
    mergedData.sort((a, b) => {
      const tsA = new Date(a.source_ts || a.timestamp).getTime();
      const tsB = new Date(b.source_ts || b.timestamp).getTime();
      return tsA - tsB;
    });

    // Apply limit
    const limit = options.limit || 100000;
    const limitedData = mergedData.slice(0, limit);

    return {
      data: limitedData,
      rowCount: limitedData.length,
      source: "hybrid",
      coldFilesUsed: coldResult.coldFilesUsed,
    };
  }

  /**
   * Generate presigned URLs for bulk export (Team/Business tiers)
   */
  async generateBulkExport(
    conditionId: string,
    options: {
      tier: DataTier;
      format?: ExportFormat;
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<BulkExportResult> {
    const { tier, format = "parquet", startDate, endDate } = options;

    // Check tier has export access
    const tierLimits = TIER_LIMITS[tier];
    const validFormats = tierLimits.exportFormats as readonly string[];
    if (!validFormats.includes(format)) {
      throw new Error(
        `Export format '${format}' not available for ${tier} tier. Available: ${tierLimits.exportFormats.join(", ")}`
      );
    }

    // Get archived files for this market
    const archiveRanges = await this.getArchiveRanges("ob_bbo", conditionId);

    // Filter by date range if specified
    let filteredRanges = archiveRanges;
    if (startDate || endDate) {
      filteredRanges = archiveRanges.filter((r) => {
        const rStart = new Date(r.minTs);
        const rEnd = new Date(r.maxTs);
        if (startDate && rEnd < startDate) return false;
        if (endDate && rStart > endDate) return false;
        return true;
      });
    }

    // Generate presigned URLs
    const bucket = this.env.ARCHIVE_BUCKET as R2Bucket;
    const files: Array<{ path: string; url: string; rows?: number }> = [];

    for (const range of filteredRanges) {
      // R2 doesn't support presigned URLs directly in Workers
      // In production, you'd use a signed URL service or custom domain
      // For now, return the paths with a placeholder URL pattern
      files.push({
        path: range.path,
        url: `https://archive.example.com/${range.path}?token=SIGNED_TOKEN`,
        rows: range.rows,
      });
    }

    const queryExample = `
-- DuckDB-WASM query example
SELECT * FROM read_parquet([${files.map((f) => `'${f.url}'`).join(", ")}])
WHERE source_ts BETWEEN '${startDate?.toISOString() || "START"}' AND '${endDate?.toISOString() || "END"}'
ORDER BY source_ts
    `.trim();

    return {
      format,
      files,
      expiresIn: 3600,
      queryExample,
    };
  }

  /**
   * Get archive ranges from manifest
   */
  private async getArchiveRanges(
    table: string,
    conditionId?: string
  ): Promise<ManifestEntry[]> {
    const bucket = this.env.ARCHIVE_BUCKET as R2Bucket;
    const manifestPath = getManifestPath(DB_CONFIG.DATABASE, table);

    try {
      const obj = await bucket.get(manifestPath);
      if (!obj) return [];

      const manifest: TableManifest = await obj.json();

      // Filter by condition_id if provided
      if (conditionId) {
        return manifest.entries.filter((e: ManifestEntry) => e.path.includes(conditionId));
      }

      return manifest.entries;
    } catch (error) {
      console.error(`[ArchiveQuery] Failed to read manifest for ${table}:`, error);
      return [];
    }
  }

  /**
   * Get the archive boundary (oldest data still in ClickHouse)
   */
  private async getArchiveBoundary(): Promise<Date> {
    // Query ClickHouse for the oldest data in hot storage
    const query = `
      SELECT min(source_ts) AS oldest_ts
      FROM ${DB_CONFIG.DATABASE}.ob_bbo
      FORMAT JSON
    `;

    try {
      const result = await this.executeClickHouseQuery(query);
      if (result.data?.[0]?.oldest_ts) {
        return new Date(result.data[0].oldest_ts);
      }
    } catch (error) {
      console.error("[ArchiveQuery] Failed to get archive boundary:", error);
    }

    // Default: assume 90 days of data in ClickHouse
    return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  }

  /**
   * Execute a ClickHouse query
   */
  private async executeClickHouseQuery(
    query: string
  ): Promise<{ data?: any[]; error?: string }> {
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
        return { error: errorText };
      }

      const result = (await response.json()) as { data: any[] };
      return { data: result.data };
    } catch (error) {
      return { error: String(error) };
    }
  }
}

/**
 * Check if a date range requires cold data access
 */
export function requiresColdData(startDate: Date, hotDataDays: number = 90): boolean {
  const hotBoundary = new Date(Date.now() - hotDataDays * 24 * 60 * 60 * 1000);
  return startDate < hotBoundary;
}

/**
 * Get the tier required for a given date range
 */
export function getRequiredTier(startDate: Date): DataTier {
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysAgo = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay);

  if (daysAgo <= 7) return "starter";
  if (daysAgo <= 90) return "pro";
  if (daysAgo <= 365) return "team";
  return "business";
}
