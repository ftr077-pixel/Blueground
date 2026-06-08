// Thin typed client for the AirROI Short-Term Rental Data API (api.airroi.com,
// OpenAPI v2.1.1). Auth is an `x-api-key` header. Only the Markets endpoints we
// need are implemented. Configuration comes from the environment:
//   AIRROI_API_KEY   – required to make live calls (else client is "not configured")
//   AIRROI_BASE_URL  – defaults to https://api.airroi.com
//
// Billing is per-call, so callers should hit this from the daily market sync and
// cache results — never per pricing pass.

import type {
  AirRoiMarket,
  MarketSummary,
  PacingPoint,
  MinNightsPoint,
} from "@/lib/repos/market";

const BASE_URL = process.env.AIRROI_BASE_URL || "https://api.airroi.com";

export function isAirRoiConfigured(): boolean {
  return !!process.env.AIRROI_API_KEY;
}

function headers(): Record<string, string> {
  return {
    "x-api-key": process.env.AIRROI_API_KEY || "",
    "content-type": "application/json",
  };
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`AirROI GET ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AirROI POST ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

/** Resolve a free-text market name to AirROI's market descriptor (first match). */
export async function searchMarket(query: string): Promise<AirRoiMarket | null> {
  const data = await get<{ entries?: AirRoiMarket[] }>("/markets/search", { query });
  return data.entries?.[0] ?? null;
}

/** Resolve a market by coordinates. */
export async function lookupMarket(lat: number, lng: number): Promise<AirRoiMarket | null> {
  try {
    return await get<AirRoiMarket>("/markets/lookup", { lat: String(lat), lng: String(lng) });
  } catch {
    return null;
  }
}

function marketBody(market: AirRoiMarket, currency: string, numMonths?: number) {
  const body: Record<string, unknown> = {
    market: {
      country: market.country,
      region: market.region,
      locality: market.locality,
      district: market.district,
    },
    currency,
  };
  if (numMonths != null) body.num_months = numMonths;
  return body;
}

export async function getMarketSummary(
  market: AirRoiMarket,
  currency: string,
  numMonths = 12,
): Promise<MarketSummary> {
  const data = await post<MarketSummary>("/markets/summary", marketBody(market, currency, numMonths));
  return data;
}

export async function getMarketFuturePacing(
  market: AirRoiMarket,
  currency: string,
): Promise<PacingPoint[]> {
  const data = await post<{ results?: PacingPoint[] }>(
    "/markets/metrics/future/pacing",
    marketBody(market, currency),
  );
  return data.results ?? [];
}

export async function getMarketMinNights(
  market: AirRoiMarket,
  currency: string,
  numMonths = 12,
): Promise<MinNightsPoint[]> {
  const data = await post<{ results?: MinNightsPoint[] }>(
    "/markets/metrics/min-nights",
    marketBody(market, currency, numMonths),
  );
  return data.results ?? [];
}
