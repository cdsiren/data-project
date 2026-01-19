// src/config/database.ts
// Centralized database configuration

export const DB_CONFIG = {
  DATABASE: "polymarket",
  TABLES: {
    TRADE_TICKS: "trade_ticks",
    OB_LATENCY: "ob_latency",
    OB_GAP_EVENTS: "ob_gap_events",
    OB_SNAPSHOTS: "ob_snapshots",
    OB_BBO: "ob_bbo",
    OB_LEVEL_CHANGES: "ob_level_changes",
    DEAD_LETTER: "dead_letter_messages",
  },
} as const;

export type TableName = keyof typeof DB_CONFIG.TABLES;

export function getFullTableName(table: TableName): string {
  return `${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES[table]}`;
}
