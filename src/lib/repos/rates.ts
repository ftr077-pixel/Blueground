import { listUnits, type Unit } from "@/lib/repos/units";
import { getDb } from "@/lib/db";

/**
 * Rates Calendar repo.
 *
 * The calendar is a deterministic *baseline* (each unit's nightly rate shaped by
 * weekend/seasonal factors, plus long mid-term booked blocks sized by occupancy),
 * with persisted *overrides* layered on top. Overrides come from two places:
 *   - operator edits in the UI            → source = "manual"
 *   - ingested actuals from MiniHotel ARI  → source = "minihotel"  (see /api/rates/snapshot)
 *
 * This is the read/write surface that replaces PriceLabs: the Reverse ARI fields
 * (Price, Availability, MinimumNights, Close) map 1:1 onto the cells below.
 */

export const DEFAULT_MIN_NIGHTS = 30;
export const CURRENCY = "ILS";
const EPOCH = Date.UTC(2026, 0, 1); // stable origin so booked blocks don't shift between requests

export interface RateCell {
  date: string; // YYYY-MM-DD
  price: number; // nightly rate, ILS
  available: number; // sellable units that night (0/1 for a single apartment)
  minNights: number;
  closed: boolean;
  booked: boolean;
  weekend: boolean;
  source: "derived" | "manual" | "minihotel";
}

export interface RateRow {
  unit: Pick<
    Unit,
    "id" | "name" | "neighborhood" | "bedrooms" | "platform" | "currentRate" | "baseRate"
  >;
  cells: RateCell[];
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

/** Long mid-term stays as deterministic booked blocks; density tracks occupancy. */
function bookedSet(unit: Unit, untilIdx: number): Set<number> {
  const r = mulberry32(hashStr("book:" + unit.id));
  const occ = Math.min(0.98, Math.max(0.4, unit.occupancy30d || 0.8));
  const set = new Set<number>();
  let day = 1 + Math.floor(r() * 20);
  while (day <= untilIdx) {
    const len = 28 + Math.floor(r() * 30); // 28..57-night stay
    for (let k = 0; k < len && day + k <= untilIdx; k++) set.add(day + k);
    const gap = Math.max(1, Math.round((1 - occ) * 55 * (0.4 + 0.6 * r())));
    day += len + gap;
  }
  return set;
}

/** Occasional maintenance closure, ~every 70-110 nights, for ~1/3 of units. */
function closedSet(unit: Unit, fromIdx: number, toIdx: number): Set<number> {
  const set = new Set<number>();
  const h = hashStr("cls:" + unit.id);
  if (h % 3 !== 0) return set;
  const r = mulberry32(h);
  let day = 5 + Math.floor(r() * 40);
  while (day <= toIdx) {
    for (let k = 0; k < 3; k++) {
      const d = day + k;
      if (d >= fromIdx && d <= toIdx) set.add(d);
    }
    day += 70 + Math.floor(r() * 40);
  }
  return set;
}

function basePrice(unit: Unit, iso: string, idx: number): number {
  let p = unit.currentRate || unit.baseRate || 600;
  const dow = weekdayUTC(iso);
  if (dow === 5 || dow === 6) p *= 1.06; // Fri/Sat (Israeli weekend)
  p *= 1 + 0.04 * Math.sin(idx / 30); // mild seasonality
  p *= 0.98 + 0.04 * mulberry32(hashStr(unit.id + iso))(); // small per-night jitter
  return Math.round(p / 5) * 5;
}

// --------------------------------------------------------------------- reads
export function unitExists(id: string): boolean {
  return listUnits().some((u) => u.id === id);
}

export function getCalendar(from: string, days: number): Calendar {
  const units = listUnits();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(isoAddDays(from, i));
  const fromIdx = dayIndex(from);
  const toIdx = fromIdx + days - 1;

  const db = getDb();
  const ovRows = db
    .prepare("SELECT * FROM rate_calendar WHERE date >= ? AND date <= ?")
    .all(from, dates[dates.length - 1] ?? from) as OverrideSql[];
  const ov = new Map<string, OverrideSql>();
  for (const r of ovRows) ov.set(r.unit_id + "|" + r.date, r);

  const rows: RateRow[] = units.map((unit) => {
    const booked = bookedSet(unit, toIdx);
    const closed = closedSet(unit, fromIdx, toIdx);
    const cells: RateCell[] = dates.map((date) => {
      const idx = dayIndex(date);
      let price = basePrice(unit, date, idx);
      let minNights = DEFAULT_MIN_NIGHTS;
      let isClosed = closed.has(idx);
      let isBooked = booked.has(idx);
      let available = isBooked || isClosed ? 0 : 1;
      let source: RateCell["source"] = "derived";

      const o = ov.get(unit.id + "|" + date);
      if (o) {
        if (o.price != null) price = o.price;
        if (o.min_nights != null) minNights = o.min_nights;
        if (o.closed != null) isClosed = o.closed === 1;
        if (o.booked != null) isBooked = o.booked === 1;
        if (o.available != null) available = o.available;
        else available = isBooked || isClosed ? 0 : 1;
        source = (o.source as RateCell["source"]) || "manual";
      }

      return {
        date,
        price,
        available,
        minNights,
        closed: isClosed,
        booked: isBooked,
        weekend: weekdayUTC(date) === 5 || weekdayUTC(date) === 6,
        source,
      };
    });
    return {
      unit: {
        id: unit.id,
        name: unit.name,
        neighborhood: unit.neighborhood,
        bedrooms: unit.bedrooms,
        platform: unit.platform,
        currentRate: unit.currentRate,
        baseRate: unit.baseRate,
      },
      cells,
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
        rev += c.price;
        bookedPrices.push(c.price);
      } else open++;
    }
  }
  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  const adr = bookedPrices.length
    ? avg(bookedPrices)
    : avg(rows.flatMap((row) => row.cells.slice(0, w).map((c) => c.price)));
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
    source,
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO rate_calendar (unit_id, date, price, available, min_nights, closed, booked, source, updated_at)
     VALUES (@unit_id, @date, @price, @available, @min_nights, @closed, @booked, @source, @updated_at)
     ON CONFLICT(unit_id, date) DO UPDATE SET
       price = @price, available = @available, min_nights = @min_nights,
       closed = @closed, booked = @booked, source = @source, updated_at = @updated_at`,
  ).run(merged);
}
