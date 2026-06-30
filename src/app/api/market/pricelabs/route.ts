import { NextResponse } from "next/server";
import {
  upsertMarketSnapshot,
  listMarketSnapshots,
  type MarketSnapshotInput,
  type MarketSummary,
  type PacingPoint,
  type MinNightsPoint,
  type MetricsPoint,
} from "@/lib/repos/market";
import { listUnits } from "@/lib/repos/units";
import { logActivity } from "@/lib/repos/activity";
import { setSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Ingest market data parsed from a PriceLabs Market Dashboard PDF export. The
// parser (scraper/pricelabs_pdf.py) POSTs here; each area is upserted into the
// SAME market_snapshots row the pricing engine already reads
// (src/lib/pricing/providers.ts → marketProviders()), so once rows land the
// engine serves them automatically — no engine change needed.
//
// market_snapshots is keyed by neighborhood, so an upsert OVERWRITES any prior
// row (incl. an AirROI one) for that area. If AIRROI_API_KEY is also configured,
// run only one source per neighborhood — last sync wins.
//
// A PriceLabs market report is usually city-wide, not per-neighborhood: pass
// neighborhood "*" (or "ALL") to fan the same snapshot out to every distinct
// portfolio neighborhood, so every unit's pricing picks it up.
//
// Bypasses the dashboard login (see middleware BYPASS); guards itself with the
// shared SCRAPER_API_KEY (header `x-scraper-key`), like the other box endpoints.

function unauthorized(req: Request): NextResponse | null {
  const required = process.env.SCRAPER_API_KEY;
  if (required) {
    if (req.headers.get("x-scraper-key") !== required) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[market/pricelabs] SCRAPER_API_KEY not set — accepting without auth (dev only)");
  }
  return null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function coerceSummary(v: unknown): MarketSummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    occupancy: num(o.occupancy),
    average_daily_rate: num(o.average_daily_rate),
    rev_par: num(o.rev_par),
    revenue: num(o.revenue),
    booking_lead_time: num(o.booking_lead_time),
    length_of_stay: num(o.length_of_stay),
    min_nights: num(o.min_nights),
    active_listings_count: num(o.active_listings_count),
  };
}

function coercePacing(v: unknown): PacingPoint[] {
  if (!Array.isArray(v)) return [];
  const out: PacingPoint[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const date = str(o.date);
    if (!date) continue;
    out.push({
      date,
      booked_count: num(o.booked_count),
      available_count: num(o.available_count),
      booked_rate_avg: num(o.booked_rate_avg),
      available_rate_avg: num(o.available_rate_avg),
      fill_rate: num(o.fill_rate),
    });
  }
  return out;
}

function coerceMinNights(v: unknown): MinNightsPoint[] {
  if (!Array.isArray(v)) return [];
  const out: MinNightsPoint[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const date = str(o.date);
    if (!date) continue;
    out.push({
      date,
      avg: num(o.avg),
      p25: num(o.p25),
      p50: num(o.p50),
      p75: num(o.p75),
      p90: num(o.p90),
    });
  }
  return out;
}

function coerceMetrics(v: unknown): MetricsPoint[] {
  if (!Array.isArray(v)) return [];
  const out: MetricsPoint[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const date = str(o.date);
    if (!date) continue;
    out.push({
      date,
      occupancy: num(o.occupancy),
      average_daily_rate: num(o.average_daily_rate),
      revpar: num(o.revpar),
      revenue: num(o.revenue),
      booking_lead_time: num(o.booking_lead_time),
      length_of_stay: num(o.length_of_stay),
      min_nights: num(o.min_nights),
      active_listings_count: num(o.active_listings_count),
    });
  }
  return out;
}

interface ParsedArea {
  neighborhood: string;
  base: Omit<MarketSnapshotInput, "neighborhood">;
}

// Turn one raw area into a parsed area (or null if it carries no usable data —
// writing an empty snapshot would erase a good cached row).
function coerceArea(raw: unknown): ParsedArea | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const neighborhood = typeof o.neighborhood === "string" ? o.neighborhood.trim() : "";
  if (!neighborhood) return null;
  const summary = coerceSummary(o.summary);
  const pacing = coercePacing(o.pacing);
  const minNights = coerceMinNights(o.minNights);
  const metrics = coerceMetrics(o.metrics);
  if (!summary && pacing.length === 0 && minNights.length === 0 && metrics.length === 0) {
    return null;
  }
  return {
    neighborhood,
    base: {
      marketName: str(o.marketName) ?? `${neighborhood} (PriceLabs)`,
      currency: str(o.currency) ?? "ILS",
      summary,
      pacing,
      minNights,
      metrics,
      filterLabel: str(o.filterLabel),
    },
  };
}

// "*" / "all" fans a city-wide report out to every portfolio neighborhood.
function expandTargets(neighborhood: string): string[] {
  if (neighborhood === "*" || neighborhood.toLowerCase() === "all") {
    const hoods = Array.from(
      new Set(listUnits().map((u) => u.neighborhood).filter((n): n is string => !!n && !!n.trim())),
    );
    return hoods.length ? hoods : [neighborhood];
  }
  return [neighborhood];
}

export async function POST(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rawAreas = Array.isArray(body)
    ? body
    : Array.isArray((body as { areas?: unknown })?.areas)
      ? (body as { areas: unknown[] }).areas
      : null;
  if (!rawAreas) {
    return NextResponse.json(
      { error: "expected { areas: [{ neighborhood, summary?, pacing?, minNights?, metrics? }] }" },
      { status: 400 },
    );
  }

  const parsed = rawAreas.map(coerceArea).filter((a): a is ParsedArea => a !== null);
  const written: string[] = [];
  for (const area of parsed) {
    for (const neighborhood of expandTargets(area.neighborhood)) {
      upsertMarketSnapshot({ neighborhood, ...area.base, source: "pricelabs" });
      written.push(neighborhood);
    }
  }
  // Importing PriceLabs data makes it the source of truth: the dashboard, the
  // pricing engine, base-price + pacing all read the active source, and the
  // AirROI sync no-ops while it's set. Flip on a successful ingest.
  if (written.length > 0) setSetting("market_source", "pricelabs");

  const skipped = rawAreas.length - parsed.length;
  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `PriceLabs PDF market sync: ${written.length} area(s) refreshed${
      skipped ? `, ${skipped} skipped (no data)` : ""
    }.`,
    level: written.length === 0 ? "warning" : "info",
  });

  return NextResponse.json({ ok: true, written: written.length, skipped, neighborhoods: written });
}

// Status: what's currently cached (handy for confirming an ingest landed).
export async function GET(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const snaps = listMarketSnapshots();
  return NextResponse.json({
    count: snaps.length,
    lastFetched: snaps.reduce<string | null>(
      (max, s) => (max && max > s.fetchedAt ? max : s.fetchedAt),
      null,
    ),
    neighborhoods: snaps.map((s) => s.neighborhood),
  });
}
