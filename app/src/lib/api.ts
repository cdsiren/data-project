import type { OHLCResponse, TopActivityResponse } from "@/types";
import { config } from "./config";
import { logger } from "./logger";

const API_BASE = config.apiBase;
const DASHBOARD_API_KEY = config.dashboardApiKey;

// Simple auth state - no sessionStorage to avoid desync with server
let isAuthenticated = false;

// Runtime type validators
function isTopActivityResponse(data: unknown): data is TopActivityResponse {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;

  return (
    "data" in obj &&
    "timestamp" in obj &&
    typeof obj.timestamp === "string" &&
    (obj.data === null ||
      (typeof obj.data === "object" &&
        obj.data !== null &&
        "asset_id" in obj.data &&
        "condition_id" in obj.data &&
        "tick_count" in obj.data))
  );
}

function isOHLCResponse(data: unknown): data is OHLCResponse {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;

  return (
    "data" in obj &&
    Array.isArray(obj.data) &&
    "asset_id" in obj &&
    "interval" in obj &&
    "hours" in obj &&
    typeof obj.asset_id === "string"
  );
}

/**
 * Fetch the most active market by tick count over 15 minutes
 */
export async function fetchTopActivity(): Promise<TopActivityResponse> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/markets/top-activity`);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch top activity: ${response.status} ${response.statusText}`
      );
    }

    const data: unknown = await response.json();

    if (!isTopActivityResponse(data)) {
      logger.error("API", "Invalid top activity response:", data);
      throw new Error("Invalid response format from server");
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Network error while fetching top activity");
  }
}

/**
 * Fetch OHLC data for a specific asset
 */
export async function fetchOHLC(
  assetId: string,
  interval: string = "1m",
  hours: number = 24
): Promise<OHLCResponse> {
  if (!assetId || typeof assetId !== "string") {
    throw new Error("Invalid assetId provided");
  }

  try {
    const params = new URLSearchParams({ interval, hours: hours.toString() });
    const response = await fetch(
      `${API_BASE}/api/v1/ohlc/${encodeURIComponent(assetId)}?${params}`
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch OHLC: ${response.status} ${response.statusText}`
      );
    }

    const data: unknown = await response.json();

    if (!isOHLCResponse(data)) {
      logger.error("API", "Invalid OHLC response:", data);
      throw new Error("Invalid response format from server");
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Network error while fetching OHLC for ${assetId}`);
  }
}

/**
 * Authenticate with the backend (sets session cookie)
 * Must be called before connecting to SSE
 * Always attempts auth - server is source of truth
 */
export async function authenticate(): Promise<boolean> {
  if (!DASHBOARD_API_KEY) {
    logger.error("API", "VITE_DASHBOARD_API_KEY not configured");
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/api/v1/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": DASHBOARD_API_KEY,
      },
      credentials: "include",
    });

    isAuthenticated = response.ok;
    if (!isAuthenticated) {
      logger.error("API", "Authentication failed:", response.status);
    }
    return isAuthenticated;
  } catch (error) {
    logger.error("API", "Authentication error:", error);
    isAuthenticated = false;
    return false;
  }
}

/**
 * Get SSE endpoint URL for trigger events
 */
export function getTriggerSSEUrl(): string {
  return `${API_BASE}/api/v1/triggers/events/sse`;
}

/**
 * Check if authenticated (local state only)
 */
export function isAuthenticatedSession(): boolean {
  return isAuthenticated;
}

/**
 * Reset authentication state
 */
export function resetAuth(): void {
  isAuthenticated = false;
}
