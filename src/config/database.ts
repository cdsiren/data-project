// src/config/database.ts
// Centralized database configuration

export const DB_CONFIG = {
  DATABASE: "polymarket",
  TABLES: {
    // Buffer tables (write to these)
    ORDER_FILLED_BUFFER: "order_filled_buffer",
    ORDERS_MATCHED_BUFFER: "orders_matched_buffer",
    GLOBAL_OPEN_INTEREST_BUFFER: "global_open_interest_buffer",
    MARKET_OPEN_INTEREST_BUFFER: "market_open_interest_buffer",
    USER_BALANCES_BUFFER: "user_balances_buffer",
    USER_POSITIONS_BUFFER: "user_positions_buffer",
    OB_SNAPSHOTS_1M_BUFFER: "ob_snapshots_1m_buffer",
    // Main tables
    ORDER_FILLED: "order_filled",
    ORDERS_MATCHED: "orders_matched",
    OB_SNAPSHOTS_1M: "ob_snapshots_1m",
    OB_TICKS_REALTIME: "ob_ticks_realtime",
    // Archive
    ARCHIVE_MANIFEST: "archive_manifest",
  },
} as const;

export type TableName = keyof typeof DB_CONFIG.TABLES;

export function getFullTableName(table: TableName): string {
  return `${DB_CONFIG.DATABASE}.${DB_CONFIG.TABLES[table]}`;
}

export interface ArchivableTableConfig {
  name: string;
  ts_col: string;
}

export const ARCHIVABLE_TABLES: ArchivableTableConfig[] = [
  { name: "order_filled", ts_col: "timestamp" },
  { name: "orders_matched", ts_col: "timestamp" },
  { name: "ob_snapshots_1m", ts_col: "minute" },
  { name: "user_balances", ts_col: "timestamp" },
  { name: "user_positions", ts_col: "timestamp" },
  { name: "global_open_interest", ts_col: "timestamp" },
  { name: "market_open_interest", ts_col: "timestamp" },
];
