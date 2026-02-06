import type { TopActivityResponse } from "@/types";
import type { MetricsResponse } from "@/types/metrics";
import { config } from "./config";
import { logger } from "./logger";

const API_BASE = config.apiBase;
const DASHBOARD_API_KEY = config.dashboardApiKey;

let isAuthenticated = false;
let authPromise: Promise<boolean> | null = null;

/**
 * Fetch the most active market by tick count
 */
export async function fetchTopActivity(): Promise<TopActivityResponse> {
  const response = await fetch(`${API_BASE}/api/v1/markets/top-activity`);
  if (!response.ok) {
    throw new Error(`Failed to fetch top activity: ${response.status}`);
  }
  return response.json();
}

/**
 * Authenticate with the backend (sets session cookie)
 */
export async function authenticate(): Promise<boolean> {
  if (!DASHBOARD_API_KEY) {
    logger.error("API", "VITE_DASHBOARD_API_KEY not configured");
    return false;
  }

  // Return existing auth attempt if in progress
  if (authPromise) return authPromise;

  authPromise = (async () => {
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
  })();

  try {
    return await authPromise;
  } finally {
    authPromise = null;
  }
}

export function getTriggerSSEUrl(): string {
  return `${API_BASE}/api/v1/triggers/events/sse`;
}

export function isAuthenticatedSession(): boolean {
  return isAuthenticated;
}

export function resetAuth(): void {
  isAuthenticated = false;
  authPromise = null;
}

/**
 * Fetch system metrics from all shards
 * Public endpoint - no authentication required
 */
export async function fetchMetrics(): Promise<MetricsResponse> {
  const response = await fetch(`${API_BASE}/do/metrics`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.status}`);
  }
  return response.json();
}
