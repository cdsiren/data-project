// src/utils/datetime.ts
// Efficient datetime formatting utilities for ClickHouse

/**
 * Converts a Unix timestamp (ms) to ClickHouse DateTime64(3) format.
 * Includes milliseconds for higher precision.
 */
export function toClickHouseDateTime64(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(Math.floor(timestampMs % 1000)).padStart(3, "0");
  return `${year}-${month}-${day} ${hour}:${min}:${sec}.${ms}`;
}

/**
 * Converts a Unix timestamp (ms) to ClickHouse DateTime64(6) format.
 * Pads milliseconds with zeros for microsecond-precision columns.
 * Use this when the column is DateTime64(6) but you only have millisecond precision.
 */
export function toClickHouseDateTime64_6(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  // Pad ms to 6 digits (microseconds) - adds 3 trailing zeros
  const us = String(Math.floor(timestampMs % 1000)).padStart(3, "0") + "000";
  return `${year}-${month}-${day} ${hour}:${min}:${sec}.${us}`;
}
