// src/utils/datetime.ts
// Efficient datetime formatting utilities for ClickHouse

/**
 * Converts a Unix timestamp (ms) to ClickHouse DateTime format.
 * More efficient than toISOString().replace().slice() pattern.
 */
export function toClickHouseDateTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
}

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
 * Converts a Unix timestamp (microseconds) to ClickHouse DateTime64(6) format.
 */
export function toClickHouseDateTime64Micro(timestampUs: number): string {
  const timestampMs = timestampUs / 1000;
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const sec = String(date.getUTCSeconds()).padStart(2, "0");
  const us = String(Math.floor(timestampUs % 1_000_000)).padStart(6, "0");
  return `${year}-${month}-${day} ${hour}:${min}:${sec}.${us}`;
}
