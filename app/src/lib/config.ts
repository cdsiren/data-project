interface Config {
  apiBase: string;
  dashboardApiKey: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

function getConfig(): Config {
  const isDevelopment = import.meta.env.DEV;
  const isProduction = import.meta.env.PROD;

  // Always use production API (no local backend needed for dashboard)
  const apiBase = "https://api.indication.xyz";

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
