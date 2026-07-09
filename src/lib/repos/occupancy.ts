import { getDb } from "@/lib/db";
import { getExcludedRoomCodes } from "@/lib/repos/integrations";

/**
 * Occupancy from MiniHotel's ARI server (Room Status Inquiry).
 *
 * These bookings have no revenue, but they're the real occupancy: which room is
 * booked which nights. We store a full snapshot each sync and compute occupancy as
 * booked room-nights / (rooms × nights in the month). Rooms come from the response's
 * <Rooms> inventory (the true denominator); test apartments are excluded throughout.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Same exclusion the revenue side uses (reservations.ts) — the Room Status view
// claims to omit cancelled stays, but if a CL/no-show row ever appears it must
// not count as occupancy.
const CANCELLED_RE = /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i;
const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const nightsOf = (a: string, b: string) => {
  const x = Date.parse(a + "T00:00:00Z");
  const y = Date.parse(b + "T00:00:00Z");
  return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, Math.round((y - x) / 86400000)) : 0;
};
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};

export interface AriBookingInput {
  resNumber: string;
  roomNumber?: string | null;
  roomType?: string | null;
  checkIn: string;
  checkOut: string;
  status?: string | null;
}
export interface AriRoomInput {
  roomNumber: string;
  roomType?: string | null;
}

/**
 * Replace the stored ARI snapshot (bookings + room inventory) with a fresh pull.
 * `window` is the date range the pull actually covered (from..to inclusive);
 * it's persisted so occupancy math can scope itself to the observed days — the
 * Room Status view starts at "today" and omits checked-out stays, so a month is
 * only ever partially observed and a full-month denominator understates it.
 */
export function storeAriOccupancy(
  bookings: AriBookingInput[],
  rooms: AriRoomInput[],
  window?: { from: string; to: string },
): { bookings: number; rooms: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM ari_booking").run();
    db.prepare("DELETE FROM ari_room").run();
    if (window && DATE_RE.test(window.from) && DATE_RE.test(window.to)) {
      const put = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      put.run("ari_window_from", window.from);
      put.run("ari_window_to", window.to);
    }
    const insB = db.prepare(
      "INSERT OR REPLACE INTO ari_booking (res_number, room_number, room_type, check_in, check_out, status, updated_at) VALUES (?,?,?,?,?,?,?)",
    );
    let nb = 0;
    for (const b of bookings) {
      const ci = (b.checkIn ?? "").slice(0, 10);
      const co = (b.checkOut ?? "").slice(0, 10);
      if (!b.resNumber || !DATE_RE.test(ci) || !DATE_RE.test(co)) continue;
      insB.run(String(b.resNumber), b.roomNumber ?? null, b.roomType ?? null, ci, co, b.status ?? null, now);
      nb++;
    }
    const insR = db.prepare("INSERT OR REPLACE INTO ari_room (room_number, room_type) VALUES (?,?)");
    let nr = 0;
    for (const r of rooms) {
      if (!r.roomNumber) continue;
      insR.run(String(r.roomNumber), r.roomType ?? null);
      nr++;
    }
    return { bookings: nb, rooms: nr };
  });
  return tx();
}

export interface OccMonth {
  month: string; // YYYY-MM
  bookedNights: number;
  availableNights: number;
  occupancy: number; // 0..1
  bookings: number; // arrivals in the month
}
export interface OccupancyReport {
  thisMonth: string;
  rooms: number; // inventory used as the denominator
  totalBookings: number;
  current: OccMonth;
  byMonth: OccMonth[]; // chronological
  /** The date range the snapshot actually observed. null = snapshot stored by a
   *  build predating the window meta — the math falls back to FULL-month
   *  denominators, which badly understates occupancy (a re-sync fixes it). */
  window: { from: string; to: string } | null;
  /** When the snapshot was pulled (the feed only knows bookings as of then). */
  syncedAt: string | null;
}

export function occupancyByMonth(thisMonth?: string): OccupancyReport {
  const db = getDb();
  const excluded = getExcludedRoomCodes();
  const isTest = (rt: string | null) => !!rt && excluded.has(rt.trim().toUpperCase());

  const roomRows = db
    .prepare("SELECT room_number, room_type FROM ari_room")
    .all() as Array<{ room_number: string; room_type: string | null }>;
  let rooms = roomRows.filter((r) => !isTest(r.room_type)).length;

  const bk = db
    .prepare("SELECT room_number, room_type, check_in, check_out, status FROM ari_booking")
    .all() as Array<{
    room_number: string | null;
    room_type: string | null;
    check_in: string;
    check_out: string;
    status: string | null;
  }>;

  // Fallback denominator if the response carried no <Rooms> inventory.
  if (rooms === 0) {
    const set = new Set<string>();
    for (const b of bk) if (!isTest(b.room_type) && b.room_number) set.add(b.room_number);
    rooms = set.size;
  }

  // The snapshot only covers the synced window (it starts at "today" and the
  // feed omits checked-out stays), so both booked nights and the denominator
  // must be scoped to the observed days — otherwise a sync on the 20th divides
  // 10 observable days of bookings by a 30-day month. Older DBs without the
  // window meta keep the previous full-month math.
  const meta = (key: string) =>
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value ?? null;
  const wFrom = meta("ari_window_from");
  const wTo = meta("ari_window_to");
  const window =
    wFrom && wTo && DATE_RE.test(wFrom) && DATE_RE.test(wTo) && wFrom <= wTo
      ? { from: wFrom, to: wTo }
      : null;
  const inWindow = (d: string) => !window || (d >= window.from && d <= window.to);
  const coveredDays = (ym: string) => {
    const full = daysInMonth(ym);
    if (!window) return full;
    const first = `${ym}-01`;
    const last = `${ym}-${String(full).padStart(2, "0")}`;
    const lo = window.from > first ? window.from : first;
    const hi = window.to < last ? window.to : last;
    return hi < lo ? 0 : nightsOf(lo, hi) + 1;
  };

  const nightsByMonth: Record<string, number> = {};
  const bookingsByMonth: Record<string, number> = {};
  // A room-night counts once even if two stored bookings cover the same room on
  // the same night (double-entry / modified reservations under two res numbers).
  const seenRoomNights = new Set<string>();
  let total = 0;
  for (const b of bk) {
    if (isTest(b.room_type)) continue;
    if (b.status && CANCELLED_RE.test(b.status)) continue;
    const n = nightsOf(b.check_in, b.check_out);
    if (n <= 0 || !DATE_RE.test(b.check_in)) continue;
    total++;
    if (inWindow(b.check_in)) {
      const arr = b.check_in.slice(0, 7);
      bookingsByMonth[arr] = (bookingsByMonth[arr] ?? 0) + 1;
    }
    for (let i = 0; i < n; i++) {
      const day = isoAddDays(b.check_in, i);
      if (!inWindow(day)) continue;
      if (b.room_number) {
        const key = `${b.room_number}|${day}`;
        if (seenRoomNights.has(key)) continue;
        seenRoomNights.add(key);
      }
      const ym = day.slice(0, 7);
      nightsByMonth[ym] = (nightsByMonth[ym] ?? 0) + 1;
    }
  }

  const months = Array.from(new Set([...Object.keys(nightsByMonth), ...Object.keys(bookingsByMonth)])).sort();
  const byMonth: OccMonth[] = months.map((m) => {
    const bn = nightsByMonth[m] ?? 0;
    const avail = rooms * coveredDays(m);
    return {
      month: m,
      bookedNights: bn,
      availableNights: avail,
      occupancy: avail > 0 ? bn / avail : 0,
      bookings: bookingsByMonth[m] ?? 0,
    };
  });

  const ym =
    thisMonth && /^\d{4}-\d{2}$/.test(thisMonth)
      ? thisMonth
      : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date()).slice(0, 7);
  const current =
    byMonth.find((x) => x.month === ym) ??
    { month: ym, bookedNights: 0, availableNights: rooms * coveredDays(ym), occupancy: 0, bookings: 0 };
  const syncedAt =
    (db.prepare("SELECT MAX(updated_at) AS ts FROM ari_booking").get() as { ts: string | null } | undefined)
      ?.ts ?? null;
  return { thisMonth: ym, rooms, totalBookings: total, current, byMonth, window, syncedAt };
}
