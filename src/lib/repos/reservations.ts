import { getDb } from "@/lib/db";
import { getMiniHotelMapping } from "@/lib/repos/integrations";

/**
 * Reservations repo — the source of *real* revenue actuals.
 *
 * MiniHotel's Content & Data API gives us the actual bookings (room revenue per
 * reservation). We store each one and recognize its revenue per night across the
 * stay, so a booking that spans a month boundary lands the right amount in each
 * month. Cancelled / no-show reservations are kept (for audit) but never counted.
 *
 * There are no costs in MiniHotel — only revenue — so this feeds the rental-revenue
 * actuals only; cost lines keep coming from the workbook.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANCELLED_RE = /cancel|no.?show|void|declin/i;

export interface ReservationInput {
  id: string;
  roomType?: string | null;
  unitId?: string | null;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD, exclusive (the morning the guest leaves)
  revenue: number; // room revenue over the whole stay, ILS
  currency?: string | null;
  status?: string | null;
}

interface ReservationSql {
  check_in: string;
  check_out: string;
  nights: number;
  revenue: number;
  status: string | null;
}

/** Whole nights between check-in and check-out (>= 1 even for a same-day quirk). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(checkIn + "T00:00:00Z");
  const b = Date.parse(checkOut + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000));
}

const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** RoomTypeCode (upper-cased) -> first mapped Hub unit id. */
function roomTypeToUnit(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of getMiniHotelMapping()) {
    if (r.roomType && !m.has(r.roomType.trim().toUpperCase())) {
      m.set(r.roomType.trim().toUpperCase(), r.unitId);
    }
  }
  return m;
}

/**
 * Upsert reservations from a pull (idempotent by id — a re-pull of an overlapping
 * window just refreshes existing rows, and cancellations arrive as status updates).
 * Validates dates/revenue and resolves each RoomTypeCode to a Hub unit via the map.
 */
export function upsertReservations(rows: ReservationInput[]): { recorded: number; skipped: number } {
  const db = getDb();
  const byRoom = roomTypeToUnit();
  const now = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO reservation (id, unit_id, room_type, check_in, check_out, nights, revenue, currency, status, source, updated_at)
     VALUES (@id, @unit_id, @room_type, @check_in, @check_out, @nights, @revenue, @currency, @status, 'minihotel', @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       unit_id = @unit_id, room_type = @room_type, check_in = @check_in, check_out = @check_out,
       nights = @nights, revenue = @revenue, currency = @currency, status = @status, updated_at = @updated_at`,
  );

  let recorded = 0;
  let skipped = 0;
  const tx = db.transaction((list: ReservationInput[]) => {
    for (const r of list) {
      const checkIn = (r.checkIn ?? "").slice(0, 10);
      const checkOut = (r.checkOut ?? "").slice(0, 10);
      const revenue = Math.round(Number(r.revenue));
      if (!r.id || !DATE_RE.test(checkIn) || !DATE_RE.test(checkOut) || !Number.isFinite(revenue)) {
        skipped++;
        continue;
      }
      const room = (r.roomType ?? "").trim();
      const unitId = r.unitId ?? (room ? (byRoom.get(room.toUpperCase()) ?? null) : null);
      upsert.run({
        id: String(r.id),
        unit_id: unitId,
        room_type: room || null,
        check_in: checkIn,
        check_out: checkOut,
        nights: nightsBetween(checkIn, checkOut),
        revenue,
        currency: r.currency ?? null,
        status: r.status ?? null,
        updated_at: now,
      });
      recorded++;
    }
  });
  tx(rows);
  return { recorded, skipped };
}

/**
 * Actual room revenue per calendar month (YYYY-MM), recognized per night across
 * each stay. Cancelled / no-show reservations are excluded.
 */
export function monthlyReservationRevenue(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT check_in, check_out, nights, revenue, status FROM reservation")
    .all() as ReservationSql[];

  const acc: Record<string, number> = {};
  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    const nights = r.nights > 0 ? r.nights : nightsBetween(r.check_in, r.check_out);
    if (nights <= 0 || !DATE_RE.test(r.check_in)) continue;
    const perNight = r.revenue / nights;
    for (let i = 0; i < nights; i++) {
      const ym = isoAddDays(r.check_in, i).slice(0, 7);
      acc[ym] = (acc[ym] ?? 0) + perNight;
    }
  }
  for (const k of Object.keys(acc)) acc[k] = Math.round(acc[k]);
  return acc;
}

export interface ReservationStats {
  count: number; // counted (non-cancelled) reservations
  cancelled: number;
  months: number; // distinct months with revenue
  revenue: number; // total counted revenue
}

export function reservationStats(): ReservationStats {
  const rows = getDb()
    .prepare("SELECT revenue, status FROM reservation")
    .all() as Array<{ revenue: number; status: string | null }>;
  let count = 0;
  let cancelled = 0;
  let revenue = 0;
  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) {
      cancelled++;
      continue;
    }
    count++;
    revenue += r.revenue;
  }
  return { count, cancelled, months: Object.keys(monthlyReservationRevenue()).length, revenue };
}
