import { getDb } from "@/lib/db";
import { getCalendar, CURRENCY } from "@/lib/repos/rates";
import {
  listMarketSnapshots,
  type MarketSnapshot,
  type PacingPoint,
  type MetricsPoint,
} from "@/lib/repos/market";
import { listProfiles } from "@/lib/repos/visibility";
import { getExcludedRoomCodes } from "@/lib/repos/integrations";

/**
 * Pacing tab assembly (the PriceLabs "Market Dashboards → Pacing" report).
 *
 * Stay-date series — pacing against the market and against yourself:
 *   - Market listed-price percentile bands come from the scraped Airbnb compset
 *     ladder (search_results): latest run per check-in, nightly prices pooled
 *     across stay lengths, 25/50/75/90th percentiles.
 *   - Market occupancy/ADR/RevPAR come from the cached AirROI snapshot: forward
 *     daily pacing for future stay dates, the monthly history for past ones, and
 *     the month−12 history value as the last-year benchmark.
 *   - Our side prefers MiniHotel reservations (real, VAT-net revenue) whenever
 *     any exist in the window; otherwise it falls back to the Rates Calendar
 *     grid (baseline + ARI booked flags) so the tab works before the first sync.
 *     Last-year lines are reservations-only: the synthetic calendar baseline is
 *     not real history and would only draw misleading zeros.
 *
 * Booking curves ("days till completion") are rebuilt from bookings.created_on:
 * for each stay month, every booking is an event at dtc = (month end − booking
 * date), and the curve is the running total of revenue / occupancy / ADR /
 * RevPAR over those events — no historical snapshots needed.
 */

export type Aggregation = "daily" | "weekly" | "monthly";

export interface PacingBucket {
  key: string; // bucket start (YYYY-MM-DD)
  label: string;
  days: number; // calendar days aggregated into this bucket
  // Market listed-price percentiles (nightly) + our average open listed price.
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  listed: number | null; // only from today forward ("last seen price")
  // Occupancy (%)
  mktOcc: number | null;
  mktOccLy: number | null;
  yourOcc: number | null;
  yourOccLy: number | null;
  unavailable: number | null; // % of room-nights blocked/closed
  // ADR
  mktAdr: number | null;
  mktAdrLy: number | null;
  yourAdr: number | null;
  yourAdrLy: number | null;
  // RevPAR
  mktRevpar: number | null;
  mktRevparLy: number | null;
  yourRevpar: number | null;
  yourRevparLy: number | null;
}

export interface CurvePoint {
  dtc: number; // days till the stay month completes (clamped to 365 = "360+")
  revenue: number;
  occ: number; // %
  adr: number | null;
  revpar: number;
}

export interface BookingCurve {
  month: string; // YYYY-MM
  label: string;
  final: boolean; // month fully in the past — curve reached completion
  points: CurvePoint[];
}

export interface PacingReport {
  from: string;
  to: string;
  agg: Aggregation;
  today: string;
  currency: string;
  rooms: number;
  dashboard: string | null; // selected market snapshot (neighborhood key)
  dashboards: { key: string; label: string; fetchedAt: string; filterLabel: string | null }[];
  compset: string; // selected search profile id, or "none"
  compsets: { id: string; label: string }[];
  buckets: PacingBucket[];
  thisBucket: string | null; // bucket containing today (the "This Month" marker)
  curves: BookingCurve[];
  curveDefaults: string[]; // past 1 + future 6 months (the PriceLabs default)
  curveSource: "bookings" | "reservations" | null;
  sources: { market: boolean; compPrices: boolean; yours: "reservations" | "calendar" | null };
}

export interface PacingQuery {
  from?: string | null;
  to?: string | null;
  agg?: string | null;
  dashboard?: string | null;
  compset?: string | null;
}

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Same exclusion the reservations repo uses for revenue.
const CANCELLED_RE = /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_WINDOW_DAYS = 750;
const DTC_CAP = 365; // events farther out collapse into the "360+" edge

const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthEnd = (ym: string) => `${ym}-${String(daysInMonth(ym)).padStart(2, "0")}`;
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
/** Same calendar date one year back, clamped for Feb 29. */
const shiftYearBack = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const ym = `${y - 1}-${String(m).padStart(2, "0")}`;
  return `${ym}-${String(Math.min(d, daysInMonth(ym))).padStart(2, "0")}`;
};
// Hotel-local (Asia/Jerusalem) today, matching the occupancy/reservations repos.
const hotelToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

function bucketStart(date: string, agg: Aggregation): string {
  if (agg === "daily") return date;
  if (agg === "weekly") {
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    return isoAddDays(date, -((dow + 6) % 7)); // Monday
  }
  return date.slice(0, 7) + "-01";
}

function bucketLabel(key: string, agg: Aggregation): string {
  const [y, m, d] = key.split("-").map(Number);
  return agg === "monthly" ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}`;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function isExcludedRoom(
  roomType: string | null,
  roomNumber: string | null,
  excluded: Set<string>,
): boolean {
  if (excluded.size === 0) return false;
  if (roomType && excluded.has(roomType.trim().toUpperCase())) return true;
  if (roomNumber && excluded.has(roomNumber.trim().toUpperCase())) return true;
  return false;
}

// ------------------------------------------------------------- our daily side
interface DayAgg {
  calBooked: number;
  calOpen: number; // known-available cells (real synced state, not fabricated)
  calValue: number; // listed price of booked calendar cells (pre-revenue ADR)
  calValueNights: number;
  resBooked: number;
  resValue: number; // VAT-net reservation revenue spread per night
  resValueNights: number;
  closed: number;
  listedSum: number; // open-looking cells with a price → "listed price"
  listedN: number;
}

interface YourSeries {
  rooms: number;
  useReservations: boolean; // any real reservation night in the window
  hasSignal: boolean; // any REAL booked/closed/availability state in the window
  byDate: Map<string, DayAgg>;
}

function yourDailySeries(from: string, days: number): YourSeries {
  const cal = getCalendar(from, days);
  const byDate = new Map<string, DayAgg>();
  for (const date of cal.dates) {
    byDate.set(date, {
      calBooked: 0,
      calOpen: 0,
      calValue: 0,
      calValueNights: 0,
      resBooked: 0,
      resValue: 0,
      resValueNights: 0,
      closed: 0,
      listedSum: 0,
      listedN: 0,
    });
  }
  // The calendar fabricates nothing (booked/closed/availability are real synced
  // state only) — so the signal is real state, never the derived price baseline.
  let hasSignal = false;
  for (const row of cal.rows) {
    for (const c of row.cells) {
      const a = byDate.get(c.date);
      if (!a) continue;
      if (c.closed) {
        a.closed++;
        hasSignal = true;
        continue;
      }
      if (c.booked) {
        a.calBooked++;
        hasSignal = true;
        if (c.price != null && c.price > 0) {
          a.calValue += c.price;
          a.calValueNights++;
        }
        continue;
      }
      if (c.available != null && c.available > 0) {
        a.calOpen++;
        hasSignal = true;
      }
      if (c.available !== 0 && c.price != null && c.price > 0) {
        a.listedSum += c.price;
        a.listedN++;
      }
    }
  }

  // Overlay real reservations (the preferred source when present).
  const to = isoAddDays(from, days - 1);
  const excluded = getExcludedRoomCodes();
  const rows = getDb()
    .prepare(
      `SELECT room_type, room_number, check_in, check_out, nights, revenue, status
       FROM reservation WHERE check_out > ? AND check_in <= ?`,
    )
    .all(from, to) as Array<{
    room_type: string | null;
    room_number: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    revenue: number;
    status: string | null;
  }>;
  // A room-night counts once even when two stored rows cover the same room that
  // night (double-entry / modified reservations) — same rule as the occupancy repo.
  const seen = new Set<string>();
  let resAny = false;
  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (isExcludedRoom(r.room_type, r.room_number, excluded)) continue;
    if (!DATE_RE.test(r.check_in) || !DATE_RE.test(r.check_out)) continue;
    const nights = r.nights > 0 ? r.nights : daysBetween(r.check_in, r.check_out);
    if (nights <= 0) continue;
    const perNight = r.revenue > 0 ? r.revenue / nights : 0;
    for (let i = 0; i < nights; i++) {
      const d = isoAddDays(r.check_in, i);
      const a = byDate.get(d);
      if (!a) continue;
      if (r.room_number) {
        const k = r.room_number + "|" + d;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      a.resBooked++;
      resAny = true;
      if (perNight > 0) {
        a.resValue += perNight;
        a.resValueNights++;
      }
    }
  }
  return { rooms: cal.rows.length, useReservations: resAny, hasSignal: hasSignal || resAny, byDate };
}

// ------------------------------------------------------------ market lookups
interface MktDay {
  occ: number; // %
  adr: number | null;
  revpar: number | null;
}

function marketLookups(snap: MarketSnapshot | null) {
  const pacing = new Map<string, PacingPoint>();
  const metrics = new Map<string, MetricsPoint>();
  for (const p of snap?.pacing ?? []) pacing.set(p.date.slice(0, 10), p);
  for (const m of snap?.metrics ?? []) metrics.set(m.date.slice(0, 7), m);

  const fromMetrics = (ym: string): MktDay | null => {
    const m = metrics.get(ym);
    if (!m) return null;
    return {
      occ: m.occupancy * 100,
      adr: m.average_daily_rate > 0 ? m.average_daily_rate : null,
      revpar: m.revpar > 0 ? m.revpar : null,
    };
  };
  const dayFor = (date: string): MktDay | null => {
    const p = pacing.get(date); // forward pacing wins where it exists
    if (p) {
      return {
        occ: p.fill_rate * 100,
        adr: p.booked_rate_avg > 0 ? p.booked_rate_avg : null,
        revpar: p.booked_rate_avg > 0 ? p.booked_rate_avg * p.fill_rate : null,
      };
    }
    return fromMetrics(date.slice(0, 7));
  };
  const lyFor = (date: string): MktDay | null => fromMetrics(addMonths(date.slice(0, 7), -12));
  return { dayFor, lyFor, hasData: pacing.size > 0 || metrics.size > 0 };
}

// ------------------------------------------- compset listed-price percentiles
interface PriceBand {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

function compPercentiles(profileId: string | null, from: string, to: string): Map<string, PriceBand> {
  const out = new Map<string, PriceBand>();
  if (!profileId) return out;
  const rows = getDb()
    .prepare(
      `SELECT check_in, nights, run_id, price_nightly FROM search_results
       WHERE profile_id = ? AND check_in >= ? AND check_in <= ?
         AND price_nightly IS NOT NULL AND price_nightly > 0
       ORDER BY ts DESC`,
    )
    .all(profileId, from, to) as Array<{
    check_in: string;
    nights: number;
    run_id: string;
    price_nightly: number;
  }>;
  // Latest run per (check-in × stay length); nightly prices pooled per check-in.
  const runFor = new Map<string, string>();
  const pool = new Map<string, number[]>();
  for (const r of rows) {
    const seg = r.check_in + "|" + r.nights;
    const run = runFor.get(seg);
    if (run === undefined) runFor.set(seg, r.run_id);
    else if (run !== r.run_id) continue;
    const arr = pool.get(r.check_in) ?? [];
    arr.push(r.price_nightly);
    pool.set(r.check_in, arr);
  }
  for (const [date, arr] of pool) {
    const s = arr.sort((a, b) => a - b);
    out.set(date, {
      p25: percentile(s, 0.25),
      p50: percentile(s, 0.5),
      p75: percentile(s, 0.75),
      p90: percentile(s, 0.9),
    });
  }
  return out;
}

// -------------------------------------------------------------- booking curves
interface StayEvent {
  created: string;
  from: string;
  to: string; // checkout, exclusive
  perNight: number | null;
}

function loadStayEvents(): { events: StayEvent[]; source: "bookings" | "reservations" | null } {
  const db = getDb();
  const events: StayEvent[] = [];
  const brows = db
    .prepare("SELECT created_on, arrival, departure, nights, total, nightly, status FROM bookings")
    .all() as Array<{
    created_on: string | null;
    arrival: string | null;
    departure: string | null;
    nights: number | null;
    total: number | null;
    nightly: number | null;
    status: string | null;
  }>;
  for (const b of brows) {
    if (b.status && /^(cl|bl)$/i.test(b.status)) continue;
    const created = (b.created_on ?? "").slice(0, 10);
    const arr = (b.arrival ?? "").slice(0, 10);
    const dep = (b.departure ?? "").slice(0, 10);
    if (!DATE_RE.test(created) || !DATE_RE.test(arr) || !DATE_RE.test(dep)) continue;
    const nights = b.nights && b.nights > 0 ? b.nights : daysBetween(arr, dep);
    if (nights <= 0) continue;
    const perNight = b.nightly ?? (b.total != null && b.total > 0 ? b.total / nights : null);
    events.push({ created, from: arr, to: dep, perNight });
  }
  if (events.length > 0) return { events, source: "bookings" };

  // Fallback: the reservation feed carries no created-at; updated_at (when we
  // first received the row) is the closest proxy for the booking date.
  const excluded = getExcludedRoomCodes();
  const rrows = db
    .prepare(
      "SELECT room_type, room_number, check_in, check_out, nights, revenue, status, updated_at FROM reservation",
    )
    .all() as Array<{
    room_type: string | null;
    room_number: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    revenue: number;
    status: string | null;
    updated_at: string | null;
  }>;
  for (const r of rrows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (isExcludedRoom(r.room_type, r.room_number, excluded)) continue;
    const created = (r.updated_at ?? "").slice(0, 10);
    if (!DATE_RE.test(created) || !DATE_RE.test(r.check_in) || !DATE_RE.test(r.check_out)) continue;
    const nights = r.nights > 0 ? r.nights : daysBetween(r.check_in, r.check_out);
    if (nights <= 0) continue;
    events.push({
      created,
      from: r.check_in,
      to: r.check_out,
      perNight: r.revenue > 0 ? r.revenue / nights : null,
    });
  }
  return { events, source: events.length > 0 ? "reservations" : null };
}

function bookingCurves(
  today: string,
  rooms: number,
): { curves: BookingCurve[]; source: "bookings" | "reservations" | null } {
  const { events, source } = loadStayEvents();
  const curYm = today.slice(0, 7);
  const curves: BookingCurve[] = [];
  for (let off = -12; off <= 12; off++) {
    const month = addMonths(curYm, off);
    const start = `${month}-01`;
    const end = monthEnd(month);
    const denom = Math.max(1, rooms) * daysInMonth(month);

    const evs: Array<{ dtc: number; nights: number; value: number; valued: number }> = [];
    for (const ev of events) {
      const oFrom = ev.from > start ? ev.from : start;
      const oTo = ev.to < isoAddDays(end, 1) ? ev.to : isoAddDays(end, 1);
      const n = daysBetween(oFrom, oTo);
      if (n <= 0) continue;
      const dtc = Math.max(0, Math.min(DTC_CAP, daysBetween(ev.created, end)));
      evs.push({
        dtc,
        nights: n,
        value: ev.perNight != null ? ev.perNight * n : 0,
        valued: ev.perNight != null ? n : 0,
      });
    }
    const final = end < today;
    if (evs.length === 0) {
      curves.push({ month, label: monthLabel(month), final, points: [] });
      continue;
    }
    evs.sort((a, b) => b.dtc - a.dtc);
    const points: CurvePoint[] = [];
    if (evs[0].dtc < DTC_CAP) points.push({ dtc: DTC_CAP, revenue: 0, occ: 0, adr: null, revpar: 0 });
    let nights = 0;
    let value = 0;
    let valued = 0;
    for (const e of evs) {
      nights += e.nights;
      value += e.value;
      valued += e.valued;
      const p: CurvePoint = {
        dtc: e.dtc,
        revenue: Math.round(value),
        occ: round1(Math.min(100, (nights / denom) * 100)),
        adr: valued > 0 ? Math.round(value / valued) : null,
        revpar: round1(value / denom),
      };
      const last = points[points.length - 1];
      if (last && last.dtc === e.dtc) points[points.length - 1] = p;
      else points.push(p);
    }
    // Extend the running total to "now" (0 for completed months) so every curve
    // reaches its current position on the axis.
    const dtcNow = final ? 0 : Math.max(0, daysBetween(today, end));
    const last = points[points.length - 1];
    if (last.dtc > dtcNow) points.push({ ...last, dtc: dtcNow });
    curves.push({ month, label: monthLabel(month), final, points });
  }
  return { curves, source };
}

// ------------------------------------------------------------------ assembly
interface Acc {
  days: number;
  yBooked: number;
  yDenom: number;
  yValue: number;
  yValueN: number;
  lyBooked: number;
  lyDenom: number;
  lyValue: number;
  lyValueN: number;
  closed: number;
  roomNights: number;
  sigN: number; // days with any real booked/closed/availability signal
  listedSum: number;
  listedN: number;
  mOcc: number;
  mOccN: number;
  mAdr: number;
  mAdrN: number;
  mRevpar: number;
  mRevparN: number;
  lOcc: number;
  lOccN: number;
  lAdr: number;
  lAdrN: number;
  lRevpar: number;
  lRevparN: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  pN: number;
}

const newAcc = (): Acc => ({
  days: 0,
  yBooked: 0,
  yDenom: 0,
  yValue: 0,
  yValueN: 0,
  lyBooked: 0,
  lyDenom: 0,
  lyValue: 0,
  lyValueN: 0,
  closed: 0,
  roomNights: 0,
  sigN: 0,
  listedSum: 0,
  listedN: 0,
  mOcc: 0,
  mOccN: 0,
  mAdr: 0,
  mAdrN: 0,
  mRevpar: 0,
  mRevparN: 0,
  lOcc: 0,
  lOccN: 0,
  lAdr: 0,
  lAdrN: 0,
  lRevpar: 0,
  lRevparN: 0,
  p25: 0,
  p50: 0,
  p75: 0,
  p90: 0,
  pN: 0,
});

export function buildPacingReport(q: PacingQuery): PacingReport {
  const today = hotelToday();
  const agg: Aggregation =
    q.agg === "daily" || q.agg === "weekly" || q.agg === "monthly" ? q.agg : "monthly";
  const curYm = today.slice(0, 7);
  let from = q.from && DATE_RE.test(q.from) ? q.from : `${addMonths(curYm, -6)}-01`;
  let to = q.to && DATE_RE.test(q.to) ? q.to : monthEnd(addMonths(curYm, 6));
  if (to < from) [from, to] = [to, from];
  let days = daysBetween(from, to) + 1;
  if (days > MAX_WINDOW_DAYS) {
    days = MAX_WINDOW_DAYS;
    to = isoAddDays(from, MAX_WINDOW_DAYS - 1);
  }

  const snapshots = listMarketSnapshots();
  const dashboards = snapshots.map((s) => ({
    key: s.neighborhood,
    label: s.marketName || s.neighborhood || "Tel Aviv",
    fetchedAt: s.fetchedAt,
    filterLabel: s.filterLabel,
  }));
  const dashboard =
    q.dashboard != null && snapshots.some((s) => s.neighborhood === q.dashboard)
      ? q.dashboard
      : (snapshots[0]?.neighborhood ?? null);
  const snap = dashboard != null ? (snapshots.find((s) => s.neighborhood === dashboard) ?? null) : null;

  const profiles = listProfiles();
  const compsets = profiles.map((p) => ({ id: p.id, label: p.label }));
  const compset =
    q.compset === "none"
      ? "none"
      : q.compset && profiles.some((p) => p.id === q.compset)
        ? q.compset
        : (profiles[0]?.id ?? "none");

  const yours = yourDailySeries(from, days);
  const lyFrom = shiftYearBack(from);
  const lyDays = daysBetween(lyFrom, shiftYearBack(to)) + 1;
  const yoursLy = yourDailySeries(lyFrom, lyDays);
  const mkt = marketLookups(snap);
  const comps = compPercentiles(compset === "none" ? null : compset, from, to);

  const accs = new Map<string, Acc>();
  for (let i = 0; i < days; i++) {
    const date = isoAddDays(from, i);
    const key = bucketStart(date, agg);
    let acc = accs.get(key);
    if (!acc) {
      acc = newAcc();
      accs.set(key, acc);
    }
    acc.days++;

    const a = yours.byDate.get(date);
    if (a) {
      // Listed price flows regardless of occupancy state — the price baseline
      // is the app's real price surface even before any booking data syncs.
      if (date >= today && a.listedN > 0) {
        acc.listedSum += a.listedSum / a.listedN;
        acc.listedN++;
      }
      if (yours.useReservations) {
        const denom = Math.max(0, yours.rooms - a.closed);
        acc.yBooked += Math.min(a.resBooked, denom > 0 ? denom : a.resBooked);
        acc.yDenom += denom;
        acc.yValue += a.resValue;
        acc.yValueN += a.resValueNights;
      } else {
        // Honest calendar fallback: only nights with real synced state count
        // (sold + known-open) — unknown nights contribute nothing, so the
        // occupancy reads null rather than a fabricated 0%.
        acc.yBooked += a.calBooked;
        acc.yDenom += a.calBooked + a.calOpen;
        acc.yValue += a.calValue;
        acc.yValueN += a.calValueNights;
      }
      acc.closed += a.closed;
      acc.roomNights += yours.rooms;
      if (yours.useReservations || a.calBooked + a.calOpen + a.closed > 0) acc.sigN++;
    }

    // Last-year "you": real reservations only — a synthetic baseline is not history.
    const b = yoursLy.byDate.get(shiftYearBack(date));
    if (b && yoursLy.useReservations) {
      const denom = Math.max(0, yoursLy.rooms - b.closed);
      acc.lyBooked += Math.min(b.resBooked, denom > 0 ? denom : b.resBooked);
      acc.lyDenom += denom;
      acc.lyValue += b.resValue;
      acc.lyValueN += b.resValueNights;
    }

    const m = mkt.dayFor(date);
    if (m) {
      acc.mOcc += m.occ;
      acc.mOccN++;
      if (m.adr != null) {
        acc.mAdr += m.adr;
        acc.mAdrN++;
      }
      if (m.revpar != null) {
        acc.mRevpar += m.revpar;
        acc.mRevparN++;
      }
    }
    const l = mkt.lyFor(date);
    if (l) {
      acc.lOcc += l.occ;
      acc.lOccN++;
      if (l.adr != null) {
        acc.lAdr += l.adr;
        acc.lAdrN++;
      }
      if (l.revpar != null) {
        acc.lRevpar += l.revpar;
        acc.lRevparN++;
      }
    }
    const c = comps.get(date);
    if (c) {
      acc.p25 += c.p25;
      acc.p50 += c.p50;
      acc.p75 += c.p75;
      acc.p90 += c.p90;
      acc.pN++;
    }
  }

  const buckets: PacingBucket[] = [...accs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, a]) => ({
      key,
      label: bucketLabel(key, agg),
      days: a.days,
      p25: a.pN ? Math.round(a.p25 / a.pN) : null,
      p50: a.pN ? Math.round(a.p50 / a.pN) : null,
      p75: a.pN ? Math.round(a.p75 / a.pN) : null,
      p90: a.pN ? Math.round(a.p90 / a.pN) : null,
      listed: a.listedN ? Math.round(a.listedSum / a.listedN) : null,
      mktOcc: a.mOccN ? round1(a.mOcc / a.mOccN) : null,
      mktOccLy: a.lOccN ? round1(a.lOcc / a.lOccN) : null,
      yourOcc: a.yDenom > 0 ? round1(Math.min(100, (a.yBooked / a.yDenom) * 100)) : null,
      yourOccLy: a.lyDenom > 0 ? round1(Math.min(100, (a.lyBooked / a.lyDenom) * 100)) : null,
      unavailable:
        a.sigN > 0 && a.roomNights > 0 ? round1((a.closed / a.roomNights) * 100) : null,
      mktAdr: a.mAdrN ? Math.round(a.mAdr / a.mAdrN) : null,
      mktAdrLy: a.lAdrN ? Math.round(a.lAdr / a.lAdrN) : null,
      yourAdr: a.yValueN > 0 ? Math.round(a.yValue / a.yValueN) : null,
      yourAdrLy: a.lyValueN > 0 ? Math.round(a.lyValue / a.lyValueN) : null,
      mktRevpar: a.mRevparN ? Math.round(a.mRevpar / a.mRevparN) : null,
      mktRevparLy: a.lRevparN ? Math.round(a.lRevpar / a.lRevparN) : null,
      yourRevpar: a.yDenom > 0 ? Math.round(a.yValue / a.yDenom) : null,
      yourRevparLy: a.lyDenom > 0 ? Math.round(a.lyValue / a.lyDenom) : null,
    }));

  const thisKey = bucketStart(today, agg);
  const { curves, source: curveSource } = bookingCurves(today, yours.rooms);
  const curveDefaults: string[] = [];
  for (let off = -1; off <= 6; off++) curveDefaults.push(addMonths(curYm, off));

  return {
    from,
    to,
    agg,
    today,
    currency: snap?.currency || CURRENCY,
    rooms: yours.rooms,
    dashboard,
    dashboards,
    compset,
    compsets,
    buckets,
    thisBucket: accs.has(thisKey) ? thisKey : null,
    curves,
    curveDefaults,
    curveSource,
    sources: {
      market: mkt.hasData,
      compPrices: comps.size > 0,
      yours: yours.useReservations ? "reservations" : yours.hasSignal ? "calendar" : null,
    },
  };
}
