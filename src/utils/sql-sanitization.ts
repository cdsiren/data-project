// src/utils/sql-sanitization.ts
// Shared SQL injection protection utilities for ClickHouse queries

/**
 * Escape a string value for safe use in ClickHouse SQL queries.
 * Prevents SQL injection by escaping single quotes and backslashes.
 */
export function escapeString(value: string): string {
  // ClickHouse uses backslash escaping for single quotes
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Validate that a value is a safe identifier (table name, column name, database name).
 * Only allows alphanumeric characters and underscores, must start with letter or underscore.
 */
export function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

/**
 * Validate and return a safe identifier, throwing if invalid.
 */
export function safeIdentifier(value: string, type: string): string {
  if (!isValidIdentifier(value)) {
    throw new Error(`Invalid ${type}: ${value}`);
  }
  return value;
}
