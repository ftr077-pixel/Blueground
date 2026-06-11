import { listUnits, type Unit } from "@/lib/repos/units";
import { getDb } from "@/lib/db";
import { quoteNight } from "@/lib/pricing/engine";
import { mockProviders, type MarketProviders } from "@/lib/pricing/providers";
import { effectiveRulesForUnit } from "@/lib/pricing/rules-config";
import type { PricingRulesConfig } from "@/lib/config/pricing";

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
}

export interface CalendarSummary {
  units: number;
  windowDays: number;
  occupancy: number; // sold / (sold + open) over the window
  adr: number; // avg booked nightly rate over the window
  bookedRevenue: number; // sum of booked nightly rates over the window
  sold: number;
  open: number;
  closed: number;
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
      if (!market) market = mockProviders();
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
      const q = hasBaseline ? priceOf(unit, date) : null;
      let price: number | null = q ? q.rate : null;
      // Default min-stay = the engine's resolved value (min-stay rules applied);
      // an override below still wins.
      let minNights = q ? q.minStay : DEFAULT_MIN_NIGHTS;
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
          if (o.min_nights != null) minNights = o.min_nights;
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
    };
  });

  // Summary over the first min(30, days) nights.
  const w = Math.min(30, days);
  let sold = 0;
  let open = 0;
  let closedN = 0;
  let rev = 0;
  const bookedPrices: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < w; i++) {
      const c = row.cells[i];
      if (!c) continue;
      if (c.closed) closedN++;
      else if (c.booked) {
        sold++;
        if (c.price != null) {
          rev += c.price;
          bookedPrices.push(c.price);
        }
      } else if (c.available != null && c.available > 0) open++; // known-open; null = unsynced, skip
    }
  }
  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  const knownPrices = rows.flatMap((row) =>
    row.cells.slice(0, w).map((c) => c.price).filter((p): p is number => p != null),
  );
  const adr = bookedPrices.length ? avg(bookedPrices) : avg(knownPrices);
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
      bookedRevenue: rev,
      sold,
      open,
      closed: closedN,
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
        upsertOverride(unitId, date, { booked: false }, "minihotel");
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
    `INSERT INTO rate_calendar (unit_id, date, price, available, min_nights, closed, booked, min_price, max_price, pct_adjust, expires_on, note, source, created_at, updated_at)
     VALUES (@unit_id, @date, @price, @available, @min_nights, @closed, @booked, @min_price, @max_price, @pct_adjust, @expires_on, @note, @source, @created_at, @updated_at)
     ON CONFLICT(unit_id, date) DO UPDATE SET
       price = @price, available = @available, min_nights = @min_nights,
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
): { date: string; price: number }[] {
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

  const out: { date: string; price: number }[] = [];
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

      let price = priceOf(unit, date).rate; // unit already carries the new base
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
      out.push({ date, price });
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
