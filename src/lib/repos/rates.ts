import { listUnits, type Unit } from "@/lib/repos/units";
import { getDb } from "@/lib/db";
import { windowReservationRevenue } from "@/lib/repos/reservations";
import { quoteNight, type DateQuote } from "@/lib/pricing/engine";
import { marketProviders, type MarketProviders } from "@/lib/pricing/providers";
import { effectiveRulesForUnit, effectiveNeighborhood } from "@/lib/pricing/rules-config";
import { roundRate, type PricingRulesConfig } from "@/lib/config/pricing";
import { listMarketSnapshots } from "@/lib/repos/market";

/**
 * Rates Calendar repo.
 *
 * Prices are a deterministic *baseline* (each unit's base rate shaped by
 * weekend/seasonal factors) with persisted *overrides* layered on top. Overrides
 * come from two places:
 *   - operator edits in the UI            → source = "manual"
 *   - ingested actuals from MiniHotel ARI  → source = "minihotel"  (see /api/rates/snapshot)
 *
 * Booked / closed / availability are REAL data only — they exist solely as
 * overrides written by the MiniHotel sync or the operator. Nights without data
 * are unknown (never fabricated), so occupancy reads honestly at any horizon.
 *
 * This is the read/write surface that replaces PriceLabs: the Reverse ARI fields
 * (Price, Availability, MinimumNights, Close) map 1:1 onto the cells below.
 */

export const DEFAULT_MIN_NIGHTS = 3; // operator default (PriceLabs setup: 3/3 weekday/weekend)
export const CURRENCY = "ILS";

/**
 * ⚠️ REMEMBER: the operator's flat 33% cut.
 * Every "what would this gross FOR US" number derived from calendar prices —
 * the Monthly-estimate column and the Unsold value (summary tile + the
 * calendar's Day-totals row) — is NET of this cut: sticker price × 0.67.
 * The nightly prices displayed on the calendar grid (and pushed to MiniHotel)
 * are full sticker prices; only these derived revenue figures take the cut.
 */
export const OPERATOR_NET_FACTOR = 0.67; // = 1 − 33%
const EPOCH = Date.UTC(2026, 0, 1); // stable origin for day indexing + per-night price jitter

export interface RateCell {
  date: string; // YYYY-MM-DD
  price: number | null; // nightly rate, ILS; null = no data yet (not synced)
  available: number | null; // sellable units that night; null = unknown
  minNights: number;
  closed: boolean;
  booked: boolean;
  weekend: boolean;
  source: "derived" | "manual" | "minihotel";
  /** Per-date price floor/ceiling overrides (clamp the derived price). */
  minPrice: number | null;
  maxPrice: number | null;
  /** Dynamic "% of recommended price" override (signed %), reapplied to the
   *  derived rate on every read — unlike a fixed price it keeps moving. */
  pctAdjust: number | null;
  /** Override auto-disables after this date (PriceLabs DSO expiry). */
  expiresOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  note: string | null;
}

export interface RankInfo {
  rank: number | null;
  total: number | null;
  page: number | null;
  ts: string;
  nights: number;
  found: boolean;
}

export interface RateRow {
  unit: Pick<
    Unit,
    | "id"
    | "name"
    | "neighborhood"
    | "bedrooms"
    | "platform"
    | "currentRate"
    | "baseRate"
    | "minRate"
    | "maxRate"
    | "minRatePinned"
    | "maxRatePinned"
    | "group"
    | "subgroup"
  >;
  cells: RateCell[];
  /** Occupancy over the next 30/60/90 nights from today (sold ÷ sellable), null when unknown. */
  occ30: number | null;
  occ60: number | null;
  occ90: number | null;
  /** Latest Airbnb search position for the ~1-month stay, via the linked tracked listing. */
  airbnbRank: RankInfo | null;
  /** "Monthly estimate": from the first date a 30-night stay can start, the sum
   *  of those 30 nightly rates minus 33%. null when the unit has no prices. */
  monthlyEstimate: { from: string; total: number; nightly: number } | null;
}

export interface CalendarSummary {
  units: number;
  windowDays: number;
  occupancy: number; // sold / (sold + open) over the window
  adr: number; // realized net nightly rate over the window (reservation actuals; falls back to displayed-rate averages when none cover it)
  bookedRevenue: number; // net-of-VAT reservation revenue recognized per night over the window (0 = no reservation data)
  sold: number;
  open: number;
  closed: number;
  /** Σ displayed nightly price over the window's open nights × 0.67 — what the
   *  unsold inventory would still gross FOR US if every open night sold at its
   *  current rate, NET of the operator's 33% cut (same deduction as the
   *  Monthly estimate; see OPERATOR_NET_FACTOR). */
  unsoldValue: number;
}

export interface Calendar {
  from: string;
  days: number;
  dates: string[];
  currency: string;
  defaultMinNights: number;
  rows: RateRow[];
  summary: CalendarSummary;
}

/** One line in the per-night price breakdown (the hover card on the calendar).
 *  Ordered as the engine applies them: base → market factors → clamp → finishers
 *  → calendar overrides, each carrying the running ₪ subtotal after it. */
export type BreakdownKind = "base" | "market" | "customization" | "threshold" | "override";
export interface BreakdownStep {
  key: string;
  label: string;
  detail: string;
  /** Signed % this step moved the running price; null for base / threshold / pin rows. */
  pct: number | null;
  /** Running ₪ price AFTER this step. */
  subtotal: number;
  kind: BreakdownKind;
}
export interface PriceBreakdown {
  unitId: string;
  date: string;
  leadDays: number;
  base: number;
  steps: BreakdownStep[];
  minPrice: number;
  maxPrice: number;
  /** Engine-derived price before any per-date calendar override (PriceLabs "recommended"). */
  recommended: number;
  /** The price actually shown on the calendar (after manual / % / per-date min-max overrides). */
  final: number;
  minStay: number;
  minStaySource: string;
  source: "derived" | "manual" | "minihotel";
  note: string | null;
  /** Raw AirROI market inputs that fed this night's market factors, or null when
   *  no market data is synced (the engine then uses the configured curve). */
  market: MarketInputs | null;
}

/** The AirROI numbers behind a night's market factors — surfaced in the hover
 *  card so each factor shows the figure it came from. */
export interface MarketInputs {
  /** "airroi" = a snapshot for this listing's neighborhood fed the factors;
   *  "fallback" = snapshots exist but none matched, so market-wide values applied. */
  source: "airroi" | "fallback";
  neighborhood: string;
  marketName: string | null;
  fetchedAt: string | null;
  /** Forward occupancy (fill_rate) for THIS date, 0..1, or null. */
  fillRate: number | null;
  /** Market booked ADR for THIS date (₪), or null. */
  bookedRateAvg: number | null;
  /** Market summary forward occupancy 0..1 (market-wide mean on fallback). */
  occupancy: number | null;
  /** Market summary ADR (₪), or null. */
  adr: number | null;
  /** Market median minimum nights, or null. */
  minNights: number | null;
  /** Market booking lead time (days), or null. */
  leadTime: number | null;
}

export interface OverridePatch {
  price?: number | null;
  available?: number | null;
  minNights?: number | null;
  closed?: boolean | null;
  booked?: boolean | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  /** Dynamic % of recommended price (signed %, e.g. -10). Cleared by null. */
  pctAdjust?: number | null;
  /** Auto-disable the override after this date (null = never). */
  expiresOn?: string | null;
  note?: string | null;
}

interface OverrideSql {
  unit_id: string;
  date: string;
  price: number | null;
  available: number | null;
  min_nights: number | null;
  /** Where min_nights came from ("manual" pin vs "minihotel" mirror). A synced
   *  value is the PMS's current state, not an operator decision, so it must not
   *  mask the engine's min-stay rules on the calendar. */
  min_nights_source: string | null;
  closed: number | null;
  booked: number | null;
  source: string;
  updated_at: string | null;
  min_price: number | null;
  max_price: number | null;
  pct_adjust: number | null;
  expires_on: string | null;
  created_at: string | null;
  note: string | null;
}

// ---------------------------------------------------------------- deterministic
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayIndex(iso: string): number {
  return Math.round((Date.parse(iso + "T00:00:00Z") - EPOCH) / 86400000);
}
function isoAddDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function weekdayUTC(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay(); // 0 Sun .. 6 Sat
}

// Legacy hardcoded curve — kept ONLY as the crash-safe fallback when the rules
// engine throws on a config edge case, so the calendar can never blank out.
function legacyCurve(unit: Unit, iso: string, idx: number): number {
  let p = unit.currentRate || unit.baseRate || 600;
  const dow = weekdayUTC(iso);
  if (dow === 4 || dow === 5) p *= 1.06; // Thu/Fri (operator's weekend definition)
  p *= 1 + 0.04 * Math.sin(idx / 30); // mild seasonality
  p *= 0.98 + 0.04 * mulberry32(hashStr(unit.id + iso))(); // small per-night jitter
  return Math.round(p / 5) * 5;
}

/**
 * Derived nightly prices come from the SAME rules engine the Pricing
 * Configuration page edits — seasonality, weekend/day-of-week, far-out,
 * last-minute, occupancy rules, min-price rules, the unit's floor/ceiling,
 * smoothing and rounding — so configuration changes actually shape the
 * calendar (and what gets pushed to MiniHotel). Build one pricer per
 * operation: providers/config are constructed once and every (unit, night)
 * quote is memoized.
 */
type NightPrice = { rate: number; minStay: number };
function makeNightPricer(): (unit: Unit, iso: string) => NightPrice {
  let market: MarketProviders | null = null;
  const asOf = new Date();
  const cfgCache = new Map<string, PricingRulesConfig>();
  const memo = new Map<string, NightPrice>();
  return (unit, iso) => {
    const k = unit.id + "|" + iso;
    const hit = memo.get(k);
    if (hit) return hit;
    let out: NightPrice;
    try {
      // Use the SAME market source as the pricing agent / preview graph: the
      // live AirROI providers when market data has been synced, else the mock.
      // This is what makes the market-driven modes (last-minute, far-out,
      // occupancy) actually track the market on the calendar — "Hyper Local
      // Pulse" — instead of demo signals. Falls back to mock with no data.
      if (!market) market = marketProviders();
      let cfg = cfgCache.get(unit.id);
      if (!cfg) {
        cfg = effectiveRulesForUnit(unit);
        cfgCache.set(unit.id, cfg);
      }
      const q = quoteNight(unit, new Date(iso + "T00:00:00Z"), market, asOf, cfg);
      out = { rate: q.rate, minStay: q.minStay };
    } catch {
      out = { rate: legacyCurve(unit, iso, dayIndex(iso)), minStay: DEFAULT_MIN_NIGHTS };
    }
    memo.set(k, out);
    return out;
  };
}

// --------------------------------------------------------------------- reads
export function unitExists(id: string): boolean {
  return listUnits().some((u) => u.id === id);
}

// Hotel-local (Asia/Jerusalem) today; the occupancy horizons always count from
// today regardless of the window the operator is viewing (PriceLabs semantics).
const hotelToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

// Market factors (vs. customizations) for the hover card's grouping — mirrors
// how PriceLabs splits "Market Factors" from "Price Customizations".
const BREAKDOWN_MARKET_KEYS = new Set(["seasonality", "demand", "pacing", "bookingRecency"]);
// Cosmetic finishers the engine applies AFTER the min/max clamp.
const BREAKDOWN_FINISHER_KEYS = new Set(["override", "offset", "smoothing", "rounding"]);
const pctRound1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The full, ordered price walk for ONE (unit, night) — what the calendar hover
 * card shows: Base → market factors → min/max clamp → finishers (offset /
 * smoothing / rounding) → per-date calendar overrides (manual price, % of
 * recommended, per-date min/max). Mirrors getCalendar()'s price resolution so
 * `final` equals the number on the grid. Returns null when the unit has no Base
 * anchor (nothing to explain) or the engine throws.
 */
export function priceBreakdown(unitId: string, date: string): PriceBreakdown | null {
  const unit = listUnits().find((u) => u.id === unitId);
  if (!unit) return null;
  const hasBaseline = (unit.currentRate || 0) > 0 || (unit.baseRate || 0) > 0;
  if (!hasBaseline) return null;

  let q: DateQuote;
  try {
    q = quoteNight(unit, new Date(date + "T00:00:00Z"), marketProviders(), new Date(), effectiveRulesForUnit(unit));
  } catch {
    return null;
  }

  const steps: BreakdownStep[] = [];
  let running = q.base;
  steps.push({ key: "base", label: "Base price", detail: "listing anchor", pct: null, subtotal: Math.round(running), kind: "base" });

  let clampDone = false;
  const applyClamp = () => {
    clampDone = true;
    if (q.bound === "floor" && running < q.minPrice) {
      running = q.minPrice;
      steps.push({ key: "floor", label: "Min price", detail: `floor ₪${Math.round(q.minPrice)} (${q.minPriceSource}) — clamped up`, pct: null, subtotal: Math.round(running), kind: "threshold" });
    } else if (q.bound === "ceiling" && running > unit.maxRate) {
      running = unit.maxRate;
      steps.push({ key: "ceiling", label: "Max price", detail: `ceiling ₪${Math.round(unit.maxRate)} — clamped down`, pct: null, subtotal: Math.round(running), kind: "threshold" });
    }
  };

  for (const f of q.factors) {
    // The clamp slots in after the multiplicative factors but before the cosmetic
    // finishers — exactly the engine's order — so the walk lands on q.rate.
    if (!clampDone && BREAKDOWN_FINISHER_KEYS.has(f.key)) applyClamp();
    if (f.pin != null) running = f.pin;
    else running = running * f.factor + (f.add ?? 0);
    running = Math.round(running);
    const pct = f.pin != null || f.add ? null : pctRound1((f.factor - 1) * 100);
    steps.push({
      key: f.key,
      label: f.label,
      detail: f.detail,
      pct,
      subtotal: running,
      kind: BREAKDOWN_MARKET_KEYS.has(f.key) ? "market" : "customization",
    });
  }
  if (!clampDone) applyClamp();

  // Trust the engine's authoritative output for the recommended price (covers any
  // rounding drift in the step-by-step walk above).
  const recommended = q.rate;
  running = recommended;

  let source: PriceBreakdown["source"] = "derived";
  let minStay = q.minStay;
  let minStaySource = q.minStaySource;
  let note: string | null = null;

  // Per-date calendar override layer — identical rules to getCalendar(): a
  // manual/synced fixed price wins outright; otherwise a dynamic % of the
  // recommended price, then the per-date min/max clamp.
  const o = getDb()
    .prepare("SELECT * FROM rate_calendar WHERE unit_id = ? AND date = ? LIMIT 1")
    .get(unitId, date) as OverrideSql | undefined;
  const expired = o?.expires_on != null && hotelToday() > o.expires_on;
  if (o && !expired) {
    if (o.price != null) {
      running = o.price;
      source = (o.source as PriceBreakdown["source"]) || "manual";
      steps.push({
        key: "manualPrice",
        label: source === "minihotel" ? "Synced price · MiniHotel" : "Manual price",
        detail: source === "minihotel" ? "mirrors the PMS for this date" : "operator-pinned for this date",
        pct: null,
        subtotal: Math.round(running),
        kind: "override",
      });
      note =
        source === "minihotel"
          ? "This night mirrors MiniHotel's price; the steps above are the auto-recommendation it would otherwise use."
          : "This night is a manual override; the steps above are the auto-recommendation it replaced.";
    } else {
      if (o.pct_adjust != null) {
        const np = Math.max(0, Math.round(running * (1 + o.pct_adjust / 100)));
        steps.push({ key: "pctAdjust", label: "% of recommended", detail: `${o.pct_adjust > 0 ? "+" : ""}${o.pct_adjust}% applied to the recommended price`, pct: o.pct_adjust, subtotal: np, kind: "override" });
        running = np;
        source = (o.source as PriceBreakdown["source"]) || "manual";
      }
      if (o.min_price != null && running < o.min_price) {
        running = o.min_price;
        steps.push({ key: "dateMin", label: "Date min price", detail: "per-date floor override", pct: null, subtotal: Math.round(running), kind: "threshold" });
      }
      if (o.max_price != null && running > o.max_price) {
        running = o.max_price;
        steps.push({ key: "dateMax", label: "Date max price", detail: "per-date ceiling override", pct: null, subtotal: Math.round(running), kind: "threshold" });
      }
    }
    if (o.min_nights != null && o.min_nights_source === "manual") {
      minStay = o.min_nights;
      minStaySource = "manual override";
    }
  }

  return {
    unitId,
    date,
    leadDays: q.leadDays,
    base: Math.round(q.base),
    steps,
    minPrice: Math.round(q.minPrice),
    maxPrice: Math.round(unit.maxRate),
    recommended: Math.round(recommended),
    final: Math.round(running),
    minStay,
    minStaySource,
    source,
    note,
    market: marketInputsFor(unit, date),
  };
}

/** The raw AirROI figures the engine read for one (unit, night): the snapshot for
 *  the unit's effective neighborhood + that date's forward pacing point. Mirrors
 *  airRoiProviders()'s lookups so the hover card shows the numbers behind the
 *  market factors. null when nothing is synced (engine uses the configured curve). */
function marketInputsFor(unit: Unit, date: string): MarketInputs | null {
  const snaps = listMarketSnapshots();
  if (snaps.length === 0) return null;
  const hood = effectiveNeighborhood(unit);
  const snap = snaps.find((s) => s.neighborhood === hood) ?? null;
  if (!snap) {
    // Snapshots exist but none for this neighborhood — the providers fall back to
    // the market-wide mean occupancy; surface just that.
    const occs = snaps.map((s) => s.summary?.occupancy).filter((x): x is number => x != null && x > 0);
    const globalOcc = occs.length ? occs.reduce((a, b) => a + b, 0) / occs.length : null;
    return {
      source: "fallback",
      neighborhood: hood,
      marketName: null,
      fetchedAt: null,
      fillRate: null,
      bookedRateAvg: null,
      occupancy: globalOcc,
      adr: null,
      minNights: null,
      leadTime: null,
    };
  }
  const pt = snap.pacing.find((p) => p.date === date) ?? null;
  const s = snap.summary;
  return {
    source: "airroi",
    neighborhood: hood,
    marketName: snap.marketName,
    fetchedAt: snap.fetchedAt,
    fillRate: pt && pt.fill_rate > 0 ? pt.fill_rate : null,
    bookedRateAvg: pt && pt.booked_rate_avg > 0 ? Math.round(pt.booked_rate_avg) : null,
    occupancy: s?.occupancy ?? null,
    adr: s?.average_daily_rate != null ? Math.round(s.average_daily_rate) : null,
    minNights: s?.min_nights ?? null,
    leadTime: s?.booking_lead_time != null ? Math.round(s.booking_lead_time) : null,
  };
}

export function getCalendar(from: string, days: number): Calendar {
  const units = listUnits();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(isoAddDays(from, i));

  const db = getDb();
  const ovRows = db
    .prepare("SELECT * FROM rate_calendar WHERE date >= ? AND date <= ?")
    .all(from, dates[dates.length - 1] ?? from) as OverrideSql[];
  const ov = new Map<string, OverrideSql>();
  for (const r of ovRows) ov.set(r.unit_id + "|" + r.date, r);

  // Overrides for the occupancy horizons (next 90 nights from today) — a
  // separate span from the viewed window.
  const occFrom = hotelToday();
  const occDates: string[] = [];
  for (let i = 0; i < 90; i++) occDates.push(isoAddDays(occFrom, i));
  const ovOccRows = db
    .prepare("SELECT * FROM rate_calendar WHERE date >= ? AND date <= ?")
    .all(occFrom, occDates[89]) as OverrideSql[];
  const ovOcc = new Map<string, OverrideSql>();
  for (const r of ovOccRows) ovOcc.set(r.unit_id + "|" + r.date, r);

  // Overrides for the Monthly-estimate search: availability is scanned up to a
  // year out (plus the 30-night stay itself) to find each unit's first
  // bookable month. Rows are sparse, so one query per request, grouped by unit.
  const EST_SEARCH_DAYS = 365;
  const ovEstByUnit = new Map<string, Map<string, OverrideSql>>();
  {
    const rows = db
      .prepare("SELECT * FROM rate_calendar WHERE date >= ? AND date < ?")
      .all(occFrom, isoAddDays(occFrom, EST_SEARCH_DAYS + 30)) as OverrideSql[];
    for (const r of rows) {
      let m = ovEstByUnit.get(r.unit_id);
      if (!m) {
        m = new Map();
        ovEstByUnit.set(r.unit_id, m);
      }
      m.set(r.date, r);
    }
  }

  // "Monthly estimate": find the first date (from today) where 30 consecutive
  // nights are bookable — not booked, not closed, not zero-availability — sum
  // those 30 nightly rates exactly as the calendar prices them (override pins,
  // dynamic %, per-date min/max on top of the engine rate), then take 20% off.
  // If no fully-open month exists within a year, fall back to the first open
  // night (the estimate is still useful, just less bookable as one block).
  const monthlyEstimateFor = (
    unit: Unit,
    hasBaseline: boolean,
    priceOf: (u: Unit, iso: string) => NightPrice,
  ): { from: string; total: number; nightly: number } | null => {
    if (!hasBaseline) return null;
    const ovByDate = ovEstByUnit.get(unit.id);
    const isBlocked = (date: string): boolean => {
      const o = ovByDate?.get(date);
      if (!o) return false;
      return o.booked === 1 || o.closed === 1 || o.available === 0;
    };
    // Walk the (few) blocked dates to find the first 30-night open gap.
    const blocked = ovByDate
      ? [...ovByDate.values()]
          .filter((o) => o.booked === 1 || o.closed === 1 || o.available === 0)
          .map((o) => o.date)
          .sort()
      : [];
    const horizonEnd = isoAddDays(occFrom, EST_SEARCH_DAYS);
    let start: string | null = null;
    let candidate = occFrom;
    for (const b of blocked) {
      if (b < candidate) continue;
      if (dayIndex(b) - dayIndex(candidate) >= 30) break; // gap before this block fits a month
      candidate = isoAddDays(b, 1);
      if (candidate > horizonEnd) break;
    }
    if (candidate <= horizonEnd) start = candidate;
    if (start == null) {
      // Fallback: the first open night within the horizon.
      let d = occFrom;
      while (d <= horizonEnd && isBlocked(d)) d = isoAddDays(d, 1);
      if (d > horizonEnd) return null;
      start = d;
    }
    const todayIso = occFrom;
    let sum = 0;
    for (let i = 0; i < 30; i++) {
      const date = isoAddDays(start, i);
      let p = priceOf(unit, date).rate;
      const o = ovByDate?.get(date);
      if (o) {
        const expired = o.expires_on != null && todayIso > o.expires_on;
        if (!expired) {
          if (o.price != null) p = o.price;
          else {
            if (o.pct_adjust != null) p = Math.max(0, Math.round(p * (1 + o.pct_adjust / 100)));
            if (o.min_price != null && p < o.min_price) p = o.min_price;
            if (o.max_price != null && p > o.max_price) p = o.max_price;
          }
        }
      }
      sum += p;
    }
    const total = Math.round(sum * OPERATOR_NET_FACTOR); // the operator's flat 33% monthly cut
    return { from: start, total, nightly: Math.round(total / 30) };
  };

  // Latest ~1-month-stay Airbnb search position per linked unit (the search
  // the visibility tab tracks; tracked_listings.unit_id is the link).
  interface RankSql {
    unit_id: string;
    rank: number | null;
    total: number | null;
    page: number | null;
    ts: string;
    nights: number;
    found: number;
  }
  const rankRows = db
    .prepare(
      `SELECT tl.unit_id, ls.rank, ls.total, ls.page, ls.ts, ls.nights, ls.found
       FROM tracked_listings tl
       JOIN listing_snapshots ls ON ls.listing_id = tl.id
       WHERE tl.unit_id IS NOT NULL AND tl.active = 1 AND ls.nights BETWEEN 28 AND 31
       ORDER BY ls.ts`,
    )
    .all() as RankSql[];
  const rankByUnit = new Map<string, RankSql>();
  for (const r of rankRows) rankByUnit.set(r.unit_id, r); // latest ts wins

  const priceOf = makeNightPricer();
  const rows: RateRow[] = units.map((unit) => {
    // Only price units that actually have a rate anchor (Base). MiniHotel
    // imports come in with rate 0 — those show nothing (price/availability =
    // null) until real data is synced in, rather than invent numbers.
    const hasBaseline = (unit.currentRate || 0) > 0 || (unit.baseRate || 0) > 0;
    const cells: RateCell[] = dates.map((date) => {
      // The min-stay hierarchy (far-out ladder, orphan gap, adjacency, last-
      // minute) doesn't depend on a Base, so resolve the engine quote for EVERY
      // unit and surface its min-stay — only the PRICE is withheld until the
      // unit has a rate anchor. This makes the configured restrictions visible
      // on the calendar even for MiniHotel-imported units (rate 0).
      const q = priceOf(unit, date);
      let price: number | null = hasBaseline ? q.rate : null;
      let minNights = q.minStay;
      // Booked / closed / availability come ONLY from real data (overrides
      // written by the MiniHotel sync or the operator) — never invented. A night
      // with no data is open-looking with unknown availability.
      let isClosed = false;
      let isBooked = false;
      let available: number | null = null;
      let source: RateCell["source"] = "derived";

      const o = ov.get(unit.id + "|" + date);
      // An expired override (PriceLabs DSO expiry) keeps its row for audit but
      // stops steering price/min-stay — the default algorithm takes over.
      const expired = o?.expires_on != null && hotelToday() > o.expires_on;
      if (o) {
        if (!expired) {
          if (o.price != null) price = o.price;
          else if (price != null) {
            // Dynamic "% of recommended": reapplied to the derived rate every
            // read (stays dynamic), then clamped by the per-date min/max.
            if (o.pct_adjust != null) price = Math.max(0, Math.round(price * (1 + o.pct_adjust / 100)));
            if (o.min_price != null && price < o.min_price) price = o.min_price;
            if (o.max_price != null && price > o.max_price) price = o.max_price;
          }
          // A synced min-stay is just a mirror of the PMS's current value — it
          // does NOT mask the engine's recommendation (same as a synced price,
          // which the Base anchor supersedes). Only a manual pin wins.
          if (o.min_nights != null && o.min_nights_source === "manual") minNights = o.min_nights;
        }
        if (o.closed != null) isClosed = o.closed === 1;
        if (o.booked != null) isBooked = o.booked === 1;
        if (o.available != null) available = o.available;
        else if (o.closed != null || o.booked != null) available = isBooked || isClosed ? 0 : 1;
        source = (o.source as RateCell["source"]) || "manual";
      }

      return {
        date,
        price,
        available,
        minNights,
        closed: isClosed,
        booked: isBooked,
        weekend: weekdayUTC(date) === 4 || weekdayUTC(date) === 5,
        source,
        minPrice: o?.min_price ?? null,
        maxPrice: o?.max_price ?? null,
        pctAdjust: expired ? null : (o?.pct_adjust ?? null),
        expiresOn: o?.expires_on ?? null,
        createdAt: o?.created_at ?? null,
        updatedAt: o?.updated_at ?? null,
        note: o?.note ?? null,
      };
    });
    // Occupancy over the next 30/60/90 nights from today: sold ÷ sellable, from
    // REAL synced data only — closed nights excluded, unknown nights skipped.
    // null when nothing is synced in the horizon (shown as "—", not a made-up %).
    const sold = [0, 0, 0];
    const open = [0, 0, 0];
    for (let i = 0; i < 90; i++) {
      let isClosed = false;
      let isBooked = false;
      let available: number | null = null;
      const o = ovOcc.get(unit.id + "|" + occDates[i]);
      if (o) {
        if (o.closed != null) isClosed = o.closed === 1;
        if (o.booked != null) isBooked = o.booked === 1;
        if (o.available != null) available = o.available;
        else if (o.closed != null || o.booked != null) available = isBooked || isClosed ? 0 : 1;
      }
      if (isClosed) continue;
      const buckets = i < 30 ? [0, 1, 2] : i < 60 ? [1, 2] : [2];
      if (isBooked) for (const b of buckets) sold[b]++;
      else if (available != null && available > 0) for (const b of buckets) open[b]++;
    }
    const occOf = (b: number) => (sold[b] + open[b] > 0 ? sold[b] / (sold[b] + open[b]) : null);

    const rk = rankByUnit.get(unit.id);

    return {
      unit: {
        id: unit.id,
        name: unit.name,
        neighborhood: unit.neighborhood,
        bedrooms: unit.bedrooms,
        platform: unit.platform,
        currentRate: unit.currentRate,
        baseRate: unit.baseRate,
        minRate: unit.minRate,
        maxRate: unit.maxRate,
        minRatePinned: unit.minRatePinned,
        maxRatePinned: unit.maxRatePinned,
        group: unit.group,
        subgroup: unit.subgroup,
      },
      cells,
      occ30: occOf(0),
      occ60: occOf(1),
      occ90: occOf(2),
      airbnbRank: rk
        ? {
            rank: rk.rank,
            total: rk.total,
            page: rk.page,
            ts: rk.ts,
            nights: rk.nights,
            found: rk.found === 1,
          }
        : null,
      monthlyEstimate: monthlyEstimateFor(unit, hasBaseline, priceOf),
    };
  });

  // Summary over the first min(30, days) nights.
  const w = Math.min(30, days);
  let sold = 0;
  let open = 0;
  let closedN = 0;
  let unsoldValue = 0;
  const bookedPrices: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < w; i++) {
      const c = row.cells[i];
      if (!c) continue;
      if (c.closed) closedN++;
      else if (c.booked) {
        sold++;
        if (c.price != null) bookedPrices.push(c.price);
      } else if (c.available != null && c.available > 0) {
        open++; // known-open; null = unsynced, skip
        if (c.price != null) unsoldValue += c.price;
      }
    }
  }
  // On-the-books is REAL money only: net-of-VAT reservation revenue recognized
  // per night over the window (same accrual as the P&L) — never the calendar's
  // displayed prices, which are advertised ARI rates / engine recommendations,
  // not what the occupying guests pay. ADR follows suit: the realized nightly
  // rate when reservations cover the window, else the old displayed-rate
  // averages so the tile stays informative before the first reservation sync.
  const otb = windowReservationRevenue(from, dates[w - 1] ?? from);
  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  const knownPrices = rows.flatMap((row) =>
    row.cells.slice(0, w).map((c) => c.price).filter((p): p is number => p != null),
  );
  const adr =
    otb.nights > 0
      ? Math.round(otb.revenue / otb.nights)
      : bookedPrices.length
        ? avg(bookedPrices)
        : avg(knownPrices);
  const occupancy = sold + open > 0 ? sold / (sold + open) : 0;

  return {
    from,
    days,
    dates,
    currency: CURRENCY,
    defaultMinNights: DEFAULT_MIN_NIGHTS,
    rows,
    summary: {
      units: units.length,
      windowDays: w,
      occupancy,
      adr,
      bookedRevenue: otb.revenue,
      sold,
      open,
      closed: closedN,
      unsoldValue: Math.round(unsoldValue * OPERATOR_NET_FACTOR), // NET of the 33% cut, like Monthly est.
    },
  };
}

// ----------------------------------------------------------- booked-night feed
/** Unavailable nights (booked OR blocked) for one unit over [from, from+days).
 *  Feeds OBA window occupancy: blocked dates count as booked for MiniHotel
 *  (it's not in PriceLabs's blocked-dates exception list). */
export function unavailableDatesForUnit(unitId: string, from: string, days: number): Set<string> {
  const out = new Set<string>();
  if (days <= 0 || !unitExists(unitId)) return out;
  const rows = getDb()
    .prepare(
      "SELECT date, booked, closed FROM rate_calendar WHERE unit_id = ? AND date >= ? AND date <= ? AND (booked = 1 OR closed = 1)",
    )
    .all(unitId, from, isoAddDays(from, days - 1)) as Array<{ date: string }>;
  for (const r of rows) out.add(r.date);
  return out;
}

/**
 * Booked nights for one unit over [from, from+days) — the override booked flags
 * the calendar renders (real synced/manual data only). Feeds the pricing
 * engine's adjacency rule (MarketProviders.isBooked). Closed-only nights are
 * NOT booked: the Adjacent Factor keys off reservations, not maintenance blocks.
 */
export function bookedDatesForUnit(unitId: string, from: string, days: number): Set<string> {
  const out = new Set<string>();
  if (days <= 0 || !unitExists(unitId)) return out;
  const rows = getDb()
    .prepare(
      "SELECT date FROM rate_calendar WHERE unit_id = ? AND date >= ? AND date <= ? AND booked = 1",
    )
    .all(unitId, from, isoAddDays(from, days - 1)) as { date: string }[];
  for (const r of rows) out.add(r.date);
  return out;
}

/**
 * Authoritatively mark one unit's SOLD nights over a window from the PMS
 * reservation list: every reservation night becomes booked (availability 0),
 * and any previously-booked night in the window with no reservation behind it
 * flips back to not-booked — so cancellations heal, and "availability 0"
 * (blocked / no allocation) is never mistaken for "sold".
 */
export function setBookedNights(unitId: string, windowDates: string[], sold: Set<string>): number {
  if (windowDates.length === 0 || !unitExists(unitId)) return 0;
  const db = getDb();
  const wasBooked = new Set(
    (
      db
        .prepare(
          "SELECT date FROM rate_calendar WHERE unit_id = ? AND date >= ? AND date <= ? AND booked = 1",
        )
        .all(unitId, windowDates[0], windowDates[windowDates.length - 1]) as { date: string }[]
    ).map((r) => r.date),
  );
  let marked = 0;
  const tx = db.transaction(() => {
    for (const date of windowDates) {
      if (sold.has(date)) {
        upsertOverride(unitId, date, { booked: true, available: 0 }, "minihotel");
        marked++;
      } else if (wasBooked.has(date)) {
        // Heal a cancellation: drop `booked` AND reset availability to unknown
        // (null). Leaving the sold night's `available: 0` in place kept it reading
        // as blocked — excluded from occupancy math and shown blocked — for months
        // on far-out dates the ~120-day ARI window no longer refills. null lets the
        // next in-window sync restore the true availability.
        upsertOverride(unitId, date, { booked: false, available: null }, "minihotel");
      }
    }
  });
  tx();
  return marked;
}

// --------------------------------------------------------------- rate anchors
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface RateAnchor {
  base: number; // ₪-rounded median nightly rate over the window (the anchor)
  current: number;
  nights: number; // how many priced calendar nights backed it
}

/**
 * A per-unit pricing anchor derived from the Rates Calendar (which merges
 * MiniHotel actuals + manual overrides over the baseline). This is what connects
 * MiniHotel rates to the pricing engine: the engine has no rates of its own, so
 * it anchors on the median nightly rate the calendar shows for each unit.
 */
export function unitRateAnchors(windowDays = 90): Map<string, RateAnchor> {
  const cal = getCalendar(new Date().toISOString().slice(0, 10), windowDays);
  const out = new Map<string, RateAnchor>();
  for (const row of cal.rows) {
    // Prefer real rates (MiniHotel actuals / manual edits) over synthetic baseline
    // cells, so a partial MiniHotel calendar isn't diluted by the ~600 default.
    // price is nullable (null = not synced yet) — narrow before comparing.
    const priced = row.cells.filter((c): c is RateCell & { price: number } => c.price != null && c.price > 0);
    const real = priced.filter((c) => c.source !== "derived").map((c) => c.price);
    const prices = real.length ? real : priced.map((c) => c.price);
    if (prices.length === 0) continue;
    const med = Math.round(median(prices) / 5) * 5;
    if (med > 0) out.set(row.unit.id, { base: med, current: med, nights: prices.length });
  }
  return out;
}

// -------------------------------------------------------------------- writes
export function upsertOverride(
  unitId: string,
  date: string,
  patch: OverridePatch,
  source: "manual" | "minihotel" = "manual",
): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM rate_calendar WHERE unit_id = ? AND date = ?")
    .get(unitId, date) as OverrideSql | undefined;

  const boolCol = (v: boolean | null | undefined, prev: number | null): number | null =>
    v !== undefined ? (v === null ? null : v ? 1 : 0) : prev;

  const merged = {
    unit_id: unitId,
    date,
    price: patch.price !== undefined ? patch.price : (existing?.price ?? null),
    available: patch.available !== undefined ? patch.available : (existing?.available ?? null),
    min_nights: patch.minNights !== undefined ? patch.minNights : (existing?.min_nights ?? null),
    // Stamp provenance whenever this write sets min_nights; clearing it (null)
    // drops the provenance too. Untouched writes keep the prior source.
    min_nights_source:
      patch.minNights !== undefined
        ? patch.minNights === null
          ? null
          : source
        : (existing?.min_nights_source ?? null),
    closed: boolCol(patch.closed, existing?.closed ?? null),
    booked: boolCol(patch.booked, existing?.booked ?? null),
    min_price: patch.minPrice !== undefined ? patch.minPrice : (existing?.min_price ?? null),
    max_price: patch.maxPrice !== undefined ? patch.maxPrice : (existing?.max_price ?? null),
    pct_adjust: patch.pctAdjust !== undefined ? patch.pctAdjust : (existing?.pct_adjust ?? null),
    expires_on: patch.expiresOn !== undefined ? patch.expiresOn : (existing?.expires_on ?? null),
    note: patch.note !== undefined ? patch.note : (existing?.note ?? null),
    source,
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO rate_calendar (unit_id, date, price, available, min_nights, min_nights_source, closed, booked, min_price, max_price, pct_adjust, expires_on, note, source, created_at, updated_at)
     VALUES (@unit_id, @date, @price, @available, @min_nights, @min_nights_source, @closed, @booked, @min_price, @max_price, @pct_adjust, @expires_on, @note, @source, @created_at, @updated_at)
     ON CONFLICT(unit_id, date) DO UPDATE SET
       price = @price, available = @available, min_nights = @min_nights, min_nights_source = @min_nights_source,
       closed = @closed, booked = @booked, min_price = @min_price, max_price = @max_price,
       pct_adjust = @pct_adjust, expires_on = @expires_on,
       note = @note, source = @source, created_at = @created_at, updated_at = @updated_at`,
  ).run(merged);
}

// ------------------------------------------------------------- base-rate rebase
//
// When the operator changes a unit's Base, the whole forward calendar must
// follow (PriceLabs semantics) — including nights currently showing a price
// synced from MiniHotel, which would otherwise outrank the rebuilt baseline.
// Manual pins (fixed prices set in Date Specific Overrides), sold nights, and
// closed nights are left alone. Returns the repriced nights so the caller can
// push them to MiniHotel.

export function rebaseFuturePrices(
  unitId: string,
  horizonDays = 90,
): { date: string; price: number; minStay: number }[] {
  const unit = listUnits().find((u) => u.id === unitId);
  if (!unit) throw new Error("unknown unit");
  // No anchor -> nothing to derive from. Without this, basePrice() would fall
  // back to its ₪600 default and a bulk push would flatten real PMS prices.
  if (!((unit.currentRate || 0) > 0 || (unit.baseRate || 0) > 0)) return [];

  const from = hotelToday();
  const fromIdx = dayIndex(from);
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM rate_calendar WHERE unit_id = ? AND date >= ? AND date <= ?")
    .all(unitId, from, isoAddDays(from, horizonDays - 1)) as OverrideSql[];
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const out: { date: string; price: number; minStay: number }[] = [];
  const clearPrice = db.prepare(
    "UPDATE rate_calendar SET price = NULL, updated_at = ? WHERE unit_id = ? AND date = ?",
  );
  const priceOf = makeNightPricer();
  const tx = db.transaction(() => {
    for (let i = 0; i < horizonDays; i++) {
      const date = isoAddDays(from, i);
      const o = byDate.get(date);
      // A manual fixed price is the operator's pin — never rebased.
      if (o && o.price != null && o.source === "manual") continue;
      // Sold/closed nights (real data only) keep their last price.
      if (o && (o.booked === 1 || o.closed === 1)) continue;

      const quote = priceOf(unit, date); // unit already carries the new base
      let price = quote.rate;
      // Push the engine's min-stay (the configured rules) — unless the operator
      // pinned a manual one for this night, which we honor and push as-is.
      const minStay =
        o && o.min_nights != null && o.min_nights_source === "manual" ? o.min_nights : quote.minStay;
      if (o) {
        // A live dynamic % override keeps steering off the new baseline.
        const expired = o.expires_on != null && from > o.expires_on;
        if (o.pct_adjust != null && !expired) {
          price = Math.max(0, Math.round(price * (1 + o.pct_adjust / 100)));
        }
        if (o.min_price != null && price < o.min_price) price = o.min_price;
        if (o.max_price != null && price > o.max_price) price = o.max_price;
        // Synced price is superseded by the new anchor; the derived price shows.
        if (o.price != null) clearPrice.run(new Date().toISOString(), unitId, date);
      }
      out.push({ date, price, minStay });
    }
    // Rows left with no payload at all are noise (stale source dots) — drop them.
    db.prepare(
      `DELETE FROM rate_calendar WHERE unit_id = ? AND price IS NULL AND available IS NULL
       AND min_nights IS NULL AND closed IS NULL AND booked IS NULL
       AND min_price IS NULL AND max_price IS NULL AND pct_adjust IS NULL
       AND expires_on IS NULL AND note IS NULL`,
    ).run(unitId);
  });
  tx();
  return out;
}

// ------------------------------------------------------- date-range overrides
//
// The Date Specific Overrides panel (PriceLabs-style): one request applies a
// patch to every night in [from..to], optionally restricted to days of the
// week. Price can be fixed (final) or a percent adjustment of each night's
// derived baseline. `clear` removes the overrides instead.

export interface RangeOverride {
  unitId: string;
  from: string;
  to: string;
  /** 0=Sun .. 6=Sat; omitted/empty = every day. */
  daysOfWeek?: number[];
  /** Fixed final nightly price (null clears the price field). */
  price?: number | null;
  /** Percent adjustment, e.g. -10 or 15. Mode picks the PriceLabs semantics:
   *  "fixed" materializes % of the derived baseline into a static price
   *  ("% of base price"); "dynamic" stores the % and reapplies it to the
   *  recommended rate on every read ("% of recommended price" — stays dynamic,
   *  honors the per-date min/max). */
  pricePct?: number;
  pricePctMode?: "fixed" | "dynamic";
  minPrice?: number | null;
  maxPrice?: number | null;
  minNights?: number | null;
  closed?: boolean | null;
  /** Auto-disable the override after this date (PriceLabs DSO expiry). */
  expiresOn?: string | null;
  note?: string | null;
  /** Remove overrides for the matching nights instead of writing. */
  clear?: boolean;
}

export const MAX_RANGE_NIGHTS = 370;

/** A night actually written by applyOverrideRange — enough to push to MiniHotel.
 *  On `clear`, cells carry the REPLACEMENT (default) values to re-push. */
export interface AppliedCell {
  date: string;
  price?: number | null;
  minNights?: number | null;
  closed?: boolean | null;
}

export function applyOverrideRange(o: RangeOverride): {
  nights: number;
  written: AppliedCell[];
  /** Cleared nights with no default to send — last pushed values stay live on the PMS. */
  unresolved: number;
} {
  const unit = listUnits().find((u) => u.id === o.unitId);
  if (!unit) throw new Error("unknown unit");

  const fromIdx = dayIndex(o.from);
  const toIdx = dayIndex(o.to);
  if (toIdx < fromIdx) throw new Error("'to' is before 'from'");
  if (toIdx - fromIdx + 1 > MAX_RANGE_NIGHTS) throw new Error(`range too long (max ${MAX_RANGE_NIGHTS} nights)`);

  const dow = o.daysOfWeek && o.daysOfWeek.length ? new Set(o.daysOfWeek) : null;
  const dates: string[] = [];
  for (let i = 0; i <= toIdx - fromIdx; i++) {
    const date = isoAddDays(o.from, i);
    if (!dow || dow.has(weekdayUTC(date))) dates.push(date);
  }

  const db = getDb();
  let nights = 0;
  let unresolved = 0;
  const written: AppliedCell[] = [];
  const hasBaseline = (unit.currentRate || 0) > 0 || (unit.baseRate || 0) > 0;
  const priceOf = makeNightPricer();
  const del = db.prepare("DELETE FROM rate_calendar WHERE unit_id = ? AND date = ?");
  const sel = db.prepare("SELECT * FROM rate_calendar WHERE unit_id = ? AND date = ?");

  const tx = db.transaction(() => {
    for (const date of dates) {
      if (o.clear) {
        // PriceLabs removal semantics ("What happens when Minimum Stay or
        // Check-in/Check-out restriction is removed"): deleting a restriction
        // must not leave the last-pushed value live on the PMS. Compute each
        // cleared night's replacement — derived price, default min-stay,
        // baseline closed state — and hand it back so the caller re-pushes the
        // defaults immediately instead of going silent.
        const existing = sel.get(o.unitId, date) as OverrideSql | undefined;
        const changes = del.run(o.unitId, date).changes;
        nights += changes;
        if (!changes || !existing) continue;
        if (!hasBaseline) {
          // Article's caveat verbatim: with no default to send, the last pushed
          // value remains on the PMS until the operator sets one.
          unresolved++;
          continue;
        }
        const sold = existing.booked === 1;
        const cell: AppliedCell = { date };
        // Only re-send fields the deleted override had actually pinned.
        if (
          !sold &&
          (existing.price != null ||
            existing.pct_adjust != null ||
            existing.min_price != null ||
            existing.max_price != null)
        ) {
          cell.price = priceOf(unit, date).rate;
        }
        if (existing.min_nights != null) cell.minNights = priceOf(unit, date).minStay;
        if (existing.closed != null) cell.closed = false; // default state is open
        if (cell.price != null || cell.minNights != null || cell.closed != null) written.push(cell);
        continue;
      }
      const patch: OverridePatch = {};
      if (o.price !== undefined) {
        patch.price = o.price;
        if (o.price !== null) patch.pctAdjust = null; // a fixed price replaces a dynamic %
      } else if (o.pricePct !== undefined) {
        // Units with no baseline yet (unsynced imports) have nothing to take a
        // percent of — skip those.
        if (!hasBaseline) continue;
        if (o.pricePctMode === "dynamic") {
          // "% of recommended": stored and reapplied at read time.
          patch.pctAdjust = o.pricePct;
          patch.price = null;
        } else {
          // "% of base (fixed)": materialized into a static price.
          patch.price = Math.max(0, Math.round(priceOf(unit, date).rate * (1 + o.pricePct / 100)));
          patch.pctAdjust = null;
        }
      }
      if (o.minPrice !== undefined) patch.minPrice = o.minPrice;
      if (o.maxPrice !== undefined) patch.maxPrice = o.maxPrice;
      if (o.minNights !== undefined) patch.minNights = o.minNights;
      if (o.closed !== undefined) patch.closed = o.closed;
      if (o.expiresOn !== undefined) patch.expiresOn = o.expiresOn;
      if (o.note !== undefined) patch.note = o.note;
      if (Object.keys(patch).length === 0) continue;
      upsertOverride(o.unitId, date, patch, "manual");
      // Fields explicitly cleared (null) push their replacement default, not
      // silence — same removal semantics as the clear path.
      const cell: AppliedCell = { date };
      if (patch.pctAdjust != null && hasBaseline) {
        // Push the dynamic %'s CURRENT resolution (it keeps moving locally).
        let p = Math.max(0, Math.round(priceOf(unit, date).rate * (1 + patch.pctAdjust / 100)));
        if (patch.minPrice != null && p < patch.minPrice) p = patch.minPrice;
        if (patch.maxPrice != null && p > patch.maxPrice) p = patch.maxPrice;
        cell.price = p;
      } else if (patch.price !== undefined) {
        if (patch.price !== null) cell.price = patch.price;
        else if (patch.pctAdjust == null) {
          if (hasBaseline) cell.price = priceOf(unit, date).rate;
          else unresolved++;
        }
      }
      if (patch.minNights !== undefined) {
        cell.minNights = patch.minNights !== null ? patch.minNights : priceOf(unit, date).minStay;
      }
      if (patch.closed !== undefined) {
        cell.closed = patch.closed !== null ? patch.closed : false; // cleared closure = open
      }
      written.push(cell);
      nights++;
    }
  });
  tx();
  return { nights, written, unresolved };
}

/**
 * Pin a target TOTAL across [from, to] for one unit, distributed by the engine's
 * recommended nightly SHAPE — so the last-minute slope toward check-in is kept
 * (nearer nights cheaper, later nights dearer) instead of a flat nightly that
 * sums to the same amount. Used when an operator accepts a monthly-sum pricing
 * suggestion: the month still totals the target, but each night follows the
 * curve. Fixed pins bypass the floor, so the near-term dip shows in full; the
 * ₪-rounding remainder is folded into the highest-weight night so the pinned
 * nights sum to `total`. No baseline (rate 0) ⇒ falls back to an even split.
 */
export function applyTotalAcrossNights(
  unitId: string,
  from: string,
  to: string,
  total: number,
  note?: string,
): { nights: number; written: AppliedCell[] } {
  const unit = listUnits().find((u) => u.id === unitId);
  if (!unit) throw new Error("unknown unit");
  const fromIdx = dayIndex(from);
  const toIdx = dayIndex(to);
  if (toIdx < fromIdx) throw new Error("'to' is before 'from'");
  if (toIdx - fromIdx + 1 > MAX_RANGE_NIGHTS) throw new Error(`range too long (max ${MAX_RANGE_NIGHTS} nights)`);
  if (!(total > 0)) return { nights: 0, written: [] };

  const dates: string[] = [];
  for (let i = 0; i <= toIdx - fromIdx; i++) dates.push(isoAddDays(from, i));

  // Weight each night by its recommended rate (the sloping curve). With no Base
  // anchor every weight is 0 — fall back to an even split so the total still lands.
  const priceOf = makeNightPricer();
  let weights = dates.map((d) => Math.max(0, priceOf(unit, d).rate));
  let sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    weights = dates.map(() => 1);
    sumW = dates.length;
  }

  const prices = weights.map((w) => Math.max(0, roundRate((total * w) / sumW)));
  // Fold the rounding remainder into the highest-weight (priciest) night.
  const drift = roundRate(total) - prices.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    let maxi = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[maxi]) maxi = i;
    prices[maxi] = Math.max(0, prices[maxi] + drift);
  }

  const written: AppliedCell[] = [];
  const db = getDb();
  const tx = db.transaction(() => {
    for (let i = 0; i < dates.length; i++) {
      upsertOverride(unitId, dates[i], { price: prices[i], note: note ?? null }, "manual");
      written.push({ date: dates[i], price: prices[i] });
    }
  });
  tx();
  return { nights: dates.length, written };
}

/**
 * Replacement values to push when single-night fields are explicitly cleared
 * (null) — the PriceLabs-safe flow: send the default in the same sync as the
 * removal so the old restriction can't linger on the PMS.
 */
export function clearedReplacements(
  unitId: string,
  date: string,
  patch: OverridePatch,
): { price?: number; minNights?: number; closed?: boolean; unresolved: boolean } {
  const unit = listUnits().find((u) => u.id === unitId);
  if (!unit) return { unresolved: true };
  const hasBaseline = (unit.currentRate || 0) > 0 || (unit.baseRate || 0) > 0;
  const priceOf = makeNightPricer();
  const out: { price?: number; minNights?: number; closed?: boolean; unresolved: boolean } = {
    unresolved: false,
  };
  if (patch.price === null) {
    if (hasBaseline) out.price = priceOf(unit, date).rate;
    else out.unresolved = true;
  }
  if (patch.minNights === null) out.minNights = priceOf(unit, date).minStay;
  if (patch.closed === null) out.closed = false; // cleared closure = open
  return out;
}
