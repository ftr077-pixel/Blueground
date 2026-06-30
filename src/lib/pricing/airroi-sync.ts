// Daily market-data sync: for each neighborhood in the portfolio, resolve the
// AirROI market once, pull summary + historical metrics + forward pacing +
// min-nights (scoped by the configured comp filter), and cache them in
// market_snapshots. No-ops cleanly when AIRROI_API_KEY isn't set.

import { listUnits } from "@/lib/repos/units";
import { getSetting } from "@/lib/repos/visibility";
import {
  upsertMarketSnapshot,
  getMarketSnapshot,
  activeMarketSource,
  type AirRoiMarket,
  type PacingPoint,
  type MinNightsPoint,
  type MetricsPoint,
} from "@/lib/repos/market";
import { logActivity } from "@/lib/repos/activity";
import {
  isAirRoiConfigured,
  searchMarket,
  getMarketSummary,
  getMarketFuturePacing,
  getMarketMinNights,
  getMarketAllMetrics,
  type MarketFilter,
  type MarketOpts,
} from "@/lib/pricing/airroi-client";

export interface SyncedArea {
  neighborhood: string;
  market: string;
  occupancy: number | null;
  pacingPoints: number;
  metricsMonths: number;
  /** Individual dataset calls that failed this sync (their cached values were kept). */
  errors?: string[];
}

export interface MarketSyncResult {
  ok: boolean;
  reason?: string;
  filterLabel: string | null;
  synced: SyncedArea[];
  failed: { neighborhood: string; error: string }[];
}

const REGION_HINT = process.env.AIRROI_REGION_HINT || "Tel Aviv-Yafo, Israel";
// AirROI accepts only 'usd' or 'native' for the currency param; 'native' auto-maps
// to the market's local currency (ILS for Israel). Display currency is separate.
const AIRROI_CURRENCY = process.env.AIRROI_CURRENCY || "native";
const DISPLAY_CURRENCY = process.env.AIRROI_DISPLAY_CURRENCY || "ILS";
const NUM_MONTHS = 12;

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

// Comp filter from settings (set in the UI). null bedrooms = all units.
function compFilter(): { filter?: MarketFilter; label: string | null } {
  const raw = getSetting("market_bedrooms");
  if (raw === null || raw === "") return { filter: undefined, label: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { filter: undefined, label: null };
  if (n >= 4) return { filter: { bedrooms: { gte: 4 } }, label: "4+ BR" };
  if (n <= 0) return { filter: { bedrooms: { eq: 0 } }, label: "studio" };
  return { filter: { bedrooms: { eq: n } }, label: `${n} BR` };
}

export async function syncMarketData(): Promise<MarketSyncResult> {
  const { filter, label } = compFilter();
  // Don't let AirROI overwrite the active source's rows when it isn't the one in
  // use (the operator switched the dashboard/engine to PriceLabs).
  if (activeMarketSource() !== "airroi") {
    return {
      ok: false,
      reason: "Market source is PriceLabs — AirROI sync is disabled (set market_source=airroi to re-enable).",
      filterLabel: label,
      synced: [],
      failed: [],
    };
  }
  if (!isAirRoiConfigured()) {
    return { ok: false, reason: "AIRROI_API_KEY not set", filterLabel: label, synced: [], failed: [] };
  }

  const neighborhoods = Array.from(new Set(listUnits().map((u) => u.neighborhood)));
  if (neighborhoods.length === 0) neighborhoods.push("");

  const opts: MarketOpts = { currency: AIRROI_CURRENCY, numMonths: NUM_MONTHS, filter };
  const synced: SyncedArea[] = [];
  const failed: { neighborhood: string; error: string }[] = [];

  for (const neighborhood of neighborhoods) {
    const query = neighborhood.trim() ? `${neighborhood}, ${REGION_HINT}` : REGION_HINT;
    try {
      let market: AirRoiMarket | null = await searchMarket(query);
      if (!market && neighborhood.trim()) market = await searchMarket(REGION_HINT);
      if (!market) {
        failed.push({ neighborhood, error: `no AirROI market matched "${query}"` });
        continue;
      }

      const errs: string[] = [];
      let summary = null;
      let summaryOk = false;
      let metrics: MetricsPoint[] = [];
      let metricsOk = false;
      let pacing: PacingPoint[] = [];
      let pacingOk = false;
      let minNights: MinNightsPoint[] = [];
      let minNightsOk = false;
      try {
        summary = await getMarketSummary(market, opts);
        summaryOk = true;
      } catch (e) {
        errs.push(`summary: ${msg(e)}`);
      }
      try {
        metrics = await getMarketAllMetrics(market, opts);
        metricsOk = true;
      } catch (e) {
        errs.push(`metrics: ${msg(e)}`);
      }
      try {
        pacing = await getMarketFuturePacing(market, opts);
        pacingOk = true;
      } catch (e) {
        errs.push(`pacing: ${msg(e)}`);
      }
      try {
        minNights = await getMarketMinNights(market, opts);
        minNightsOk = true;
      } catch (e) {
        errs.push(`min-nights: ${msg(e)}`);
      }

      if (!summary && pacing.length === 0 && metrics.length === 0) {
        failed.push({
          neighborhood,
          error: `"${market.full_name ?? query}" returned no data${errs.length ? ` — ${errs.join("; ")}` : ""}`,
        });
        continue;
      }

      // On a partial failure, keep the previously-cached value for the dataset
      // whose call failed — the upsert replaces every column, so writing the
      // empty default would erase good data (pay-per-call: not refetchable for
      // free). A call that *succeeded* with an empty result still overwrites.
      const prev = errs.length ? getMarketSnapshot(neighborhood) : null;
      if (prev) {
        if (!summaryOk) summary = prev.summary;
        if (!metricsOk) metrics = prev.metrics;
        if (!pacingOk) pacing = prev.pacing;
        if (!minNightsOk) minNights = prev.minNights;
      }

      upsertMarketSnapshot({
        neighborhood,
        marketName: market.full_name ?? null,
        currency: DISPLAY_CURRENCY,
        summary,
        pacing,
        minNights,
        metrics,
        filterLabel: label,
      });
      synced.push({
        neighborhood,
        market: market.full_name ?? query,
        occupancy: summary?.occupancy ?? null,
        pacingPoints: pacing.length,
        metricsMonths: metrics.length,
        ...(errs.length ? { errors: errs } : {}),
      });
    } catch (e) {
      failed.push({ neighborhood, error: msg(e) });
    }
  }

  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `AirROI market sync${label ? ` (${label})` : ""}: ${synced.length} area(s) refreshed${failed.length ? `, ${failed.length} failed` : ""}.`,
    level: failed.length && synced.length === 0 ? "warning" : "info",
  });

  return { ok: true, filterLabel: label, synced, failed };
}
