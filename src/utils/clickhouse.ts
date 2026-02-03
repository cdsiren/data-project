// src/utils/clickhouse.ts
// ClickHouse query utilities with SQL injection protection

import { MARKET_SOURCE_TO_TYPE } from "../config/database";

/**
 * Escape a string value for safe inclusion in ClickHouse SQL queries.
 * Handles backslashes, single quotes, and other special characters.
 *
 * @param value - The string value to escape
 * @returns Escaped string safe for SQL interpolation
 */
export function escapeClickHouseString(value: string): string {
  // ClickHouse uses backslash escaping for special characters
  return value
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/'/g, "\\'")    // Escape single quotes
    .replace(/\n/g, "\\n")   // Escape newlines
    .replace(/\r/g, "\\r")   // Escape carriage returns
    .replace(/\t/g, "\\t")   // Escape tabs
    .replace(/\0/g, "");     // Remove null bytes entirely
}

/**
 * Escape and wrap a string value for ClickHouse queries.
 * Returns the value wrapped in single quotes.
 *
 * @param value - The string value to escape and quote
 * @returns Quoted and escaped string like 'safe value'
 */
export function quoteClickHouseString(value: string): string {
  return `'${escapeClickHouseString(value)}'`;
}

/**
 * Validate that a value is a safe identifier (table name, column name, etc.)
 * Only allows alphanumeric characters and underscores.
 *
 * @param value - The identifier to validate
 * @returns true if safe, false otherwise
 */
export function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

/**
 * Escape an identifier (table name, column name) for ClickHouse.
 * Wraps in backticks and escapes internal backticks.
 *
 * @param value - The identifier to escape
 * @returns Escaped identifier
 * @throws Error if identifier contains invalid characters
 */
export function escapeIdentifier(value: string): string {
  if (!isValidIdentifier(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return value; // Safe identifiers don't need escaping
}

/**
 * Validate and escape a market source value.
 * Only allows known market sources from MARKET_SOURCE_TO_TYPE registry.
 *
 * @param value - The market source to validate
 * @returns Escaped value or null if invalid
 */
export function validateMarketSource(value: string): string | null {
  const normalized = value.toLowerCase().trim();
  // Use MARKET_SOURCE_TO_TYPE as single source of truth for valid market sources
  if (normalized in MARKET_SOURCE_TO_TYPE) {
    return normalized;
  }
  return null;
}

/**
 * Validate that a string looks like a valid asset ID (hex string).
 * Asset IDs are typically 64-character hex strings.
 *
 * @param value - The asset ID to validate
 * @returns true if valid format, false otherwise
 */
export function isValidAssetId(value: string): boolean {
  // Asset IDs are typically 64-char hex strings, but we'll be lenient
  // and allow any hex string between 16 and 128 characters
  return /^[a-fA-F0-9]{16,128}$/.test(value);
}

/**
 * Validate and escape an asset ID for safe query use.
 *
 * @param value - The asset ID to validate and escape
 * @returns Escaped asset ID
 * @throws Error if asset ID format is invalid
 */
export function escapeAssetId(value: string): string {
  const trimmed = value.trim();
  if (!isValidAssetId(trimmed)) {
    throw new Error(`Invalid asset ID format: ${value.slice(0, 20)}...`);
  }
  return trimmed; // Hex strings are safe, no escaping needed
}

/**
 * Parse and validate a numeric limit parameter.
 *
 * @param value - String value to parse
 * @param defaultValue - Default if value is empty/undefined
 * @param max - Maximum allowed value
 * @returns Validated number
 */
export function parseLimit(value: string | undefined, defaultValue: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, max);
}

/**
 * Parse and validate a numeric offset parameter.
 *
 * @param value - String value to parse
 * @param defaultValue - Default if value is empty/undefined
 * @returns Validated number (non-negative)
 */
export function parseOffset(value: string | undefined, defaultValue: number = 0): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

/**
 * Build a safe WHERE clause from conditions.
 *
 * @param conditions - Array of SQL condition strings (already escaped)
 * @returns WHERE clause or empty string
 */
export function buildWhereClause(conditions: string[]): string {
  if (conditions.length === 0) return "";
  return `WHERE ${conditions.join(" AND ")}`;
}

/**
 * Fetch with timeout wrapper for ClickHouse queries.
 *
 * @param url - ClickHouse URL
 * @param options - Fetch options
 * @param timeoutMs - Timeout in milliseconds (default 10000)
 * @returns Response
 * @throws Error on timeout
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ClickHouse query timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse ClickHouse JSONEachRow format response.
 *
 * @param text - Raw response text
 * @param transform - Optional transform function for each row
 * @returns Array of parsed rows
 */
export function parseJSONEachRow<T>(
  text: string,
  transform?: (row: Record<string, unknown>) => T
): T[] {
  if (!text.trim()) return [];

  const results: T[] = [];
  const lines = text.trim().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      results.push(transform ? transform(parsed) : parsed);
    } catch (error) {
      console.warn(`[parseJSONEachRow] Failed to parse line ${i + 1}:`, {
        line: line.slice(0, 100),
        error: error instanceof Error ? error.message : String(error),
      });
      // Skip invalid lines
    }
  }

  return results;
}
