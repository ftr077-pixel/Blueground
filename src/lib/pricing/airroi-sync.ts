// Daily market-data sync: for each neighborhood in the portfolio, resolve the
// AirROI market once, pull the summary + forward pacing + min-nights, and cache
// them in market_snapshots. Designed to run on a schedule (a few calls/day), not
// per pricing pass. No-ops cleanly when AIRROI_API_KEY isn't set.

import { listUnits } from "@/lib/repos/units";
import { upsertMarketSnapshot, type AirRoiMarket } from "@/lib/repos/market";
import { logActivity } from "@/lib/repos/activity";
import {
  isAirRoiConfigured,
  searchMarket,
  getMarketSummary,
  getMarketFuturePacing,
  getMarketMinNights,
} from "@/lib/pricing/airroi-client";

export interface MarketSyncResult {
  ok: boolean;
  reason?: string;
  synced: string[];
  failed: { neighborhood: string; error: string }[];
}

const REGION_HINT = process.env.AIRROI_REGION_HINT || "Tel Aviv-Yafo, Israel";

export async function syncMarketData(currency = "ILS"): Promise<MarketSyncResult> {
  if (!isAirRoiConfigured()) {
    return { ok: false, reason: "AIRROI_API_KEY not set", synced: [], failed: [] };
  }

  const neighborhoods = Array.from(new Set(listUnits().map((u) => u.neighborhood)));
  const synced: string[] = [];
  const failed: { neighborhood: string; error: string }[] = [];

  for (const neighborhood of neighborhoods) {
    try {
      // Resolve the market: try the specific neighborhood first, then the city.
      let market: AirRoiMarket | null = await searchMarket(`${neighborhood}, ${REGION_HINT}`);
      if (!market) market = await searchMarket(REGION_HINT);
      if (!market) {
        failed.push({ neighborhood, error: "no AirROI market match" });
        continue;
      }

      const [summary, pacing, minNights] = await Promise.all([
        getMarketSummary(market, currency).catch(() => null),
        getMarketFuturePacing(market, currency).catch(() => []),
        getMarketMinNights(market, currency).catch(() => []),
      ]);

      upsertMarketSnapshot({
        neighborhood,
        marketName: market.full_name ?? null,
        currency,
        summary,
        pacing,
        minNights,
      });
      synced.push(neighborhood);
    } catch (e) {
      failed.push({ neighborhood, error: e instanceof Error ? e.message : "unknown error" });
    }
  }

  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `AirROI market sync: ${synced.length} neighborhood(s) refreshed${failed.length ? `, ${failed.length} failed` : ""}.`,
    level: failed.length ? "warning" : "info",
  });

  return { ok: true, synced, failed };
}
