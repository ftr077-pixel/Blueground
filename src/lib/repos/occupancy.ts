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

/** Replace the stored ARI snapshot (bookings + room inventory) with a fresh pull. */
export function storeAriOccupancy(
  bookings: AriBookingInput[],
  rooms: AriRoomInput[],
): { bookings: number; rooms: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM ari_booking").run();
    db.prepare("DELETE FROM ari_room").run();
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
    .prepare("SELECT room_number, room_type, check_in, check_out FROM ari_booking")
    .all() as Array<{ room_number: string | null; room_type: string | null; check_in: string; check_out: string }>;

  // Fallback denominator if the response carried no <Rooms> inventory.
  if (rooms === 0) {
    const set = new Set<string>();
    for (const b of bk) if (!isTest(b.room_type) && b.room_number) set.add(b.room_number);
    rooms = set.size;
  }

  const nightsByMonth: Record<string, number> = {};
  const bookingsByMonth: Record<string, number> = {};
  let total = 0;
  for (const b of bk) {
    if (isTest(b.room_type)) continue;
    const n = nightsOf(b.check_in, b.check_out);
    if (n <= 0 || !DATE_RE.test(b.check_in)) continue;
    total++;
    const arr = b.check_in.slice(0, 7);
    bookingsByMonth[arr] = (bookingsByMonth[arr] ?? 0) + 1;
    for (let i = 0; i < n; i++) {
      const ym = isoAddDays(b.check_in, i).slice(0, 7);
      nightsByMonth[ym] = (nightsByMonth[ym] ?? 0) + 1;
    }
  }

  const months = Array.from(new Set([...Object.keys(nightsByMonth), ...Object.keys(bookingsByMonth)])).sort();
  const byMonth: OccMonth[] = months.map((m) => {
    const bn = nightsByMonth[m] ?? 0;
    const avail = rooms * daysInMonth(m);
    return {
      month: m,
      bookedNights: bn,
      availableNights: avail,
      occupancy: avail > 0 ? bn / avail : 0,
      bookings: bookingsByMonth[m] ?? 0,
    };
  });

  const ym = thisMonth && /^\d{4}-\d{2}$/.test(thisMonth) ? thisMonth : new Date().toISOString().slice(0, 7);
  const current =
    byMonth.find((x) => x.month === ym) ??
    { month: ym, bookedNights: 0, availableNights: rooms * daysInMonth(ym), occupancy: 0, bookings: 0 };
  return { thisMonth: ym, rooms, totalBookings: total, current, byMonth };
}
