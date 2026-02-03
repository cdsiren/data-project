interface Config {
  apiBase: string;
  dashboardApiKey: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

function getConfig(): Config {
  const isDevelopment = import.meta.env.DEV;
  const isProduction = import.meta.env.PROD;

  // API base URL for all endpoints (SSE, triggers, metrics, OHLC)
  // In development: connect to local worker (which fetches LIVE Polymarket data)
  // In production: connect to production worker (also fetches LIVE Polymarket data)
  // Both environments use the same data source - only the worker location differs
  const defaultApiBase = isDevelopment
    ? "http://localhost:8787"
    : "https://api.indication.xyz";
  const apiBase = import.meta.env.VITE_API_BASE || defaultApiBase;

  const dashboardApiKey = import.meta.env.VITE_DASHBOARD_API_KEY;

  if (!dashboardApiKey && isProduction) {
    console.error(
      "VITE_DASHBOARD_API_KEY is not set. Authentication will fail."
    );
  }

  return {
    apiBase,
    dashboardApiKey: dashboardApiKey || "",
    isDevelopment,
    isProduction,
  };
}

export const config = getConfig();
