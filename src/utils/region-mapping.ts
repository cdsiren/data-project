// src/utils/region-mapping.ts
// Region mapping for routing traders to nearest regional buffer
// Reduces latency by 10-50ms for non-EU traders

/**
 * Available regional buffer locations
 */
export type RegionalBufferLocation = "enam" | "wnam" | "weur" | "apac";

/**
 * Map of country codes to regions
 * Based on Cloudflare location hints for optimal routing
 */
const COUNTRY_TO_REGION: Record<string, RegionalBufferLocation> = {
  // Eastern North America
  US: "enam", // Default for US, refined below based on CF-IPCity or state
  CA: "enam",
  MX: "enam",
  BR: "enam",
  AR: "enam",
  CL: "enam",
  CO: "enam",
  PE: "enam",
  VE: "enam",

  // Western Europe (default for unknown/EU)
  GB: "weur",
  DE: "weur",
  FR: "weur",
  NL: "weur",
  BE: "weur",
  CH: "weur",
  AT: "weur",
  IT: "weur",
  ES: "weur",
  PT: "weur",
  IE: "weur",
  SE: "weur",
  NO: "weur",
  DK: "weur",
  FI: "weur",
  PL: "weur",
  CZ: "weur",
  RO: "weur",
  HU: "weur",
  GR: "weur",
  UA: "weur",
  RU: "weur", // Western Russia
  TR: "weur",
  ZA: "weur", // South Africa - closer to EU than APAC
  EG: "weur", // Egypt
  NG: "weur", // Nigeria
  KE: "weur", // Kenya

  // Asia Pacific
  JP: "apac",
  KR: "apac",
  CN: "apac",
  HK: "apac",
  TW: "apac",
  SG: "apac",
  MY: "apac",
  TH: "apac",
  VN: "apac",
  PH: "apac",
  ID: "apac",
  AU: "apac",
  NZ: "apac",
  IN: "apac",
  PK: "apac",
  BD: "apac",
  AE: "apac", // UAE - closer to APAC infrastructure
  SA: "apac", // Saudi Arabia
  IL: "apac", // Israel
};

/**
 * US states that should route to Western North America
 * Based on time zones and geographic proximity
 */
const WESTERN_US_STATES = new Set([
  "WA", "OR", "CA", "NV", "AZ", "UT", "ID", "MT", "WY", "CO", "NM",
  "AK", "HI", // Alaska and Hawaii
]);

/**
 * US cities that should route to Western North America
 * Used as fallback when state information is not available
 */
const WESTERN_US_CITIES = new Set([
  "Los Angeles", "San Francisco", "Seattle", "Portland", "San Diego",
  "Las Vegas", "Phoenix", "Denver", "Salt Lake City", "Sacramento",
  "San Jose", "Oakland", "Fresno", "Long Beach", "Anaheim", "Santa Ana",
  "Riverside", "Stockton", "Irvine", "Chula Vista", "Fremont", "Santa Clarita",
]);

/**
 * Get the optimal regional buffer location based on request headers.
 * Uses Cloudflare's geo headers to route to the nearest buffer.
 *
 * @param request The incoming HTTP request with Cloudflare headers
 * @returns The regional buffer location hint
 */
export function getRegionFromRequest(request: Request): RegionalBufferLocation {
  // Get Cloudflare geo headers
  const country = request.headers.get("CF-IPCountry") || "";
  const city = request.headers.get("CF-IPCity") || "";
  const region = request.headers.get("CF-Region") || ""; // US state code for US requests

  // Special handling for US: route to wnam for western states
  if (country === "US") {
    // Check state first (CF-Region header)
    if (region && WESTERN_US_STATES.has(region.toUpperCase())) {
      return "wnam";
    }
    // Fallback to city-based detection
    if (city && WESTERN_US_CITIES.has(city)) {
      return "wnam";
    }
    // Default to Eastern NA for US
    return "enam";
  }

  // Lookup country in mapping
  const mappedRegion = COUNTRY_TO_REGION[country.toUpperCase()];
  if (mappedRegion) {
    return mappedRegion;
  }

  // Default to Western Europe (where Polymarket servers are)
  return "weur";
}

// Cached array - allocated once, returned by reference
const REGIONAL_BUFFER_NAMES = ["buffer-enam", "buffer-wnam", "buffer-weur", "buffer-apac"] as const;

/**
 * Get all regional buffer names for fan-out publishing
 * @returns Array of all regional buffer identifiers (same reference each call)
 */
export function getAllRegionalBufferNames(): readonly string[] {
  return REGIONAL_BUFFER_NAMES;
}

/**
 * Get the buffer name for a specific region
 * @param region The regional location
 * @returns The buffer identifier string
 */
export function getRegionalBufferName(region: RegionalBufferLocation): string {
  return `buffer-${region}`;
}
