// Daily market-data sync: for each neighborhood in the portfolio, resolve the
// AirROI market once, pull the summary + forward pacing + min-nights, and cache
// them in market_snapshots. Designed to run on a schedule (a few calls/day), not
// per pricing pass. No-ops cleanly when AIRROI_API_KEY isn't set.

import { listUnits } from "@/lib/repos/units";
import {
  upsertMarketSnapshot,
  type AirRoiMarket,
  type PacingPoint,
  type MinNightsPoint,
} from "@/lib/repos/market";
import { logActivity } from "@/lib/repos/activity";
import {
  isAirRoiConfigured,
  searchMarket,
  getMarketSummary,
  getMarketFuturePacing,
  getMarketMinNights,
} from "@/lib/pricing/airroi-client";

export interface SyncedArea {
  neighborhood: string;
  market: string;
  occupancy: number | null;
  pacingPoints: number;
}

export interface MarketSyncResult {
  ok: boolean;
  reason?: string;
  synced: SyncedArea[];
  failed: { neighborhood: string; error: string }[];
}

const REGION_HINT = process.env.AIRROI_REGION_HINT || "Tel Aviv-Yafo, Israel";
// AirROI accepts only 'usd' or 'native' for the currency param; 'native' auto-maps
// to the market's local currency (ILS for Israel). We keep a separate display
// currency for the ₪ symbol shown in the UI.
const AIRROI_CURRENCY = process.env.AIRROI_CURRENCY || "native";
const DISPLAY_CURRENCY = process.env.AIRROI_DISPLAY_CURRENCY || "ILS";

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

export async function syncMarketData(): Promise<MarketSyncResult> {
  if (!isAirRoiConfigured()) {
    return { ok: false, reason: "AIRROI_API_KEY not set", synced: [], failed: [] };
  }

  const neighborhoods = Array.from(new Set(listUnits().map((u) => u.neighborhood)));
  // If every unit has a blank neighborhood, still sync the city-level market once.
  if (neighborhoods.length === 0) neighborhoods.push("");

  const synced: SyncedArea[] = [];
  const failed: { neighborhood: string; error: string }[] = [];

  for (const neighborhood of neighborhoods) {
    // A blank neighborhood must search the city directly — NOT ", Tel Aviv…".
    const query = neighborhood.trim() ? `${neighborhood}, ${REGION_HINT}` : REGION_HINT;
    try {
      let market: AirRoiMarket | null = await searchMarket(query);
      if (!market && neighborhood.trim()) market = await searchMarket(REGION_HINT);
      if (!market) {
        failed.push({ neighborhood, error: `no AirROI market matched "${query}"` });
        continue;
      }

      // Fetch each metric independently so one failure doesn't hide the others.
      const errs: string[] = [];
      let summary = null;
      let pacing: PacingPoint[] = [];
      let minNights: MinNightsPoint[] = [];
      try {
        summary = await getMarketSummary(market, AIRROI_CURRENCY);
      } catch (e) {
        errs.push(`summary: ${msg(e)}`);
      }
      try {
        pacing = await getMarketFuturePacing(market, AIRROI_CURRENCY);
      } catch (e) {
        errs.push(`pacing: ${msg(e)}`);
      }
      try {
        minNights = await getMarketMinNights(market, AIRROI_CURRENCY);
      } catch (e) {
        errs.push(`min-nights: ${msg(e)}`);
      }

      // Don't cache an empty row — surface why instead.
      if (!summary && pacing.length === 0) {
        failed.push({
          neighborhood,
          error: `"${market.full_name ?? query}" returned no data${errs.length ? ` — ${errs.join("; ")}` : ""}`,
        });
        continue;
      }

      upsertMarketSnapshot({
        neighborhood,
        marketName: market.full_name ?? null,
        currency: DISPLAY_CURRENCY,
        summary,
        pacing,
        minNights,
      });
      synced.push({
        neighborhood,
        market: market.full_name ?? query,
        occupancy: summary?.occupancy ?? null,
        pacingPoints: pacing.length,
      });
    } catch (e) {
      failed.push({ neighborhood, error: msg(e) });
    }
  }

  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `AirROI market sync: ${synced.length} area(s) refreshed${failed.length ? `, ${failed.length} failed` : ""}.`,
    level: failed.length && synced.length === 0 ? "warning" : "info",
  });

  return { ok: true, synced, failed };
}
