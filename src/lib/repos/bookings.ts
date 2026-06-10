import { getDb } from "@/lib/db";
import { LEAD_BUCKETS } from "@/lib/learning/config";

// A realized booking pulled from MiniHotel. id = MiniHotel reservation id.
export interface Booking {
  id: string;
  portalResId: string | null;
  unitId: string | null;
  roomType: string | null;
  source: string | null;
  status: string | null;
  createdOn: string | null; // booking date (YYYY-MM-DD)
  arrival: string | null;
  departure: string | null;
  nights: number | null;
  guests: number | null;
  total: number | null;
  nightly: number | null;
  currency: string | null;
  leadDays: number | null; // arrival − created_on
}

interface BookingSql {
  id: string;
  portal_res_id: string | null;
  unit_id: string | null;
  room_type: string | null;
  source: string | null;
  status: string | null;
  created_on: string | null;
  arrival: string | null;
  departure: string | null;
  nights: number | null;
  guests: number | null;
  total: number | null;
  nightly: number | null;
  currency: string | null;
  lead_days: number | null;
}

function rowToBooking(r: BookingSql): Booking {
  return {
    id: r.id,
    portalResId: r.portal_res_id,
    unitId: r.unit_id,
    roomType: r.room_type,
    source: r.source,
    status: r.status,
    createdOn: r.created_on,
    arrival: r.arrival,
    departure: r.departure,
    nights: r.nights,
    guests: r.guests,
    total: r.total,
    nightly: r.nightly,
    currency: r.currency,
    leadDays: r.lead_days,
  };
}

export function upsertBooking(b: Booking): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO bookings
       (id, portal_res_id, unit_id, room_type, source, status, created_on, arrival, departure,
        nights, guests, total, nightly, currency, lead_days, synced_at)
     VALUES
       (@id, @portalResId, @unitId, @roomType, @source, @status, @createdOn, @arrival, @departure,
        @nights, @guests, @total, @nightly, @currency, @leadDays, @syncedAt)
     ON CONFLICT(id) DO UPDATE SET
       portal_res_id=excluded.portal_res_id, unit_id=excluded.unit_id, room_type=excluded.room_type,
       source=excluded.source, status=excluded.status, created_on=excluded.created_on,
       arrival=excluded.arrival, departure=excluded.departure, nights=excluded.nights,
       guests=excluded.guests, total=excluded.total, nightly=excluded.nightly,
       currency=excluded.currency, lead_days=excluded.lead_days, synced_at=excluded.synced_at`,
  ).run({ ...b, syncedAt: new Date().toISOString() });
}

// Active (non-cancelled) only — for realized metrics.
const ACTIVE = "status IS NULL OR status NOT IN ('CL','BL')";

export function recentBookings(opts: { unitId?: string | null; limit?: number } = {}): Booking[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const rows = (
    opts.unitId
      ? db
          .prepare("SELECT * FROM bookings WHERE unit_id = ? ORDER BY created_on DESC, arrival DESC LIMIT ?")
          .all(opts.unitId, limit)
      : db.prepare("SELECT * FROM bookings ORDER BY created_on DESC, arrival DESC LIMIT ?").all(limit)
  ) as BookingSql[];
  return rows.map(rowToBooking);
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export interface RealizedNightly {
  p25: number;
  p50: number;
  p75: number;
  n: number;
  currency: string | null;
}

export function realizedNightly(unitId?: string | null): RealizedNightly | null {
  const db = getDb();
  const rows = (
    unitId
      ? db.prepare(`SELECT nightly, currency FROM bookings WHERE unit_id = ? AND nightly IS NOT NULL AND (${ACTIVE})`).all(unitId)
      : db.prepare(`SELECT nightly, currency FROM bookings WHERE nightly IS NOT NULL AND (${ACTIVE})`).all()
  ) as Array<{ nightly: number; currency: string | null }>;
  if (!rows.length) return null;
  const xs = rows.map((r) => r.nightly).sort((a, b) => a - b);
  return {
    p25: Math.round(pct(xs, 0.25)),
    p50: Math.round(pct(xs, 0.5)),
    p75: Math.round(pct(xs, 0.75)),
    n: xs.length,
    currency: rows[0].currency,
  };
}

export interface BookingPace {
  medianLeadDays: number | null;
  n: number;
  histogram: Array<{ key: string; label: string; count: number }>;
}

// Our booking pace: the distribution of how far ahead bookings are made. The
// benchmark we'll later compare to the market's booking-lead-time distribution.
export function bookingPace(unitId?: string | null): BookingPace {
  const db = getDb();
  const rows = (
    unitId
      ? db.prepare(`SELECT lead_days FROM bookings WHERE unit_id = ? AND lead_days IS NOT NULL AND (${ACTIVE})`).all(unitId)
      : db.prepare(`SELECT lead_days FROM bookings WHERE lead_days IS NOT NULL AND (${ACTIVE})`).all()
  ) as Array<{ lead_days: number }>;
  const xs = rows.map((r) => r.lead_days).filter((v) => v >= 0).sort((a, b) => a - b);
  const histogram = LEAD_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: xs.filter((v) => v >= b.min && v <= b.max).length,
  }));
  const median = xs.length
    ? xs.length % 2
      ? xs[(xs.length - 1) / 2]
      : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
    : null;
  return { medianLeadDays: median, n: xs.length, histogram };
}
