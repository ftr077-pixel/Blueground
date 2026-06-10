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
  MetricsPoint,
} from "@/lib/repos/market";

/** AirROI filter: { field: { eq|gt|gte|lt|lte|range|any|all|none } }, fields ANDed. */
export type MarketFilter = Record<string, Record<string, unknown>>;
export interface MarketOpts {
  currency: string;
  numMonths?: number;
  filter?: MarketFilter;
}

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

// The market sync makes up to 5 sequential calls per neighborhood; without a
// timeout one stalled connection wedges the whole /api/market/sync request for
// undici's multi-minute default. Same 20s budget as the MiniHotel client.
const TIMEOUT_MS = 20000;

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`AirROI GET ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

function marketBody(market: AirRoiMarket, opts: MarketOpts) {
  const body: Record<string, unknown> = {
    market: {
      country: market.country,
      region: market.region,
      locality: market.locality,
      district: market.district,
    },
    currency: opts.currency,
  };
  if (opts.numMonths != null) body.num_months = opts.numMonths;
  if (opts.filter && Object.keys(opts.filter).length) body.filter = opts.filter;
  return body;
}

export async function getMarketSummary(market: AirRoiMarket, opts: MarketOpts): Promise<MarketSummary> {
  return post<MarketSummary>("/markets/summary", marketBody(market, opts));
}

export async function getMarketFuturePacing(market: AirRoiMarket, opts: MarketOpts): Promise<PacingPoint[]> {
  const data = await post<{ results?: PacingPoint[] }>(
    "/markets/metrics/future/pacing",
    marketBody(market, opts),
  );
  return data.results ?? [];
}

export async function getMarketMinNights(market: AirRoiMarket, opts: MarketOpts): Promise<MinNightsPoint[]> {
  const data = await post<{ results?: MinNightsPoint[] }>(
    "/markets/metrics/min-nights",
    marketBody(market, opts),
  );
  return data.results ?? [];
}

// One call returns the full monthly historical series of every market metric.
export async function getMarketAllMetrics(market: AirRoiMarket, opts: MarketOpts): Promise<MetricsPoint[]> {
  const data = await post<{ results?: MetricsPoint[] }>(
    "/markets/metrics/all",
    marketBody(market, opts),
  );
  return data.results ?? [];
}
