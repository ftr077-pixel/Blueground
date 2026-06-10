import {
  getMiniHotelConnection,
  getMiniHotelMapping,
  miniHotelEndpoints,
  type MiniHotelConnection,
} from "@/lib/repos/integrations";
import { upsertBooking } from "@/lib/repos/bookings";
import {
  buildReservationsRequest,
  parseReservations,
  reservationToBooking,
} from "./minihotel-bookings-parse";

export { buildReservationsRequest, parseReservations } from "./minihotel-bookings-parse";
export type { ParsedReservation } from "./minihotel-bookings-parse";

/**
 * MiniHotel booking-outcomes sync (server-side).
 *
 * Pulls reservations from the Content & Data API (GetReservationKey, §3.3) for a
 * CreateDate window, maps each RoomTypeCode to a Hub unit, and stores them as
 * realized booking outcomes: booked price, stay dates, and booking lead time
 * (arrival − created-on). Calls MiniHotel directly from the box (whitelisted IP);
 * pass `xml` to parse a captured response offline (tests).
 */

export interface BookingSyncResult {
  ok: boolean;
  from: string;
  to: string;
  parsed: number;
  mapped: number;
  stored: number;
  unmappedTypes: string[];
  message?: string;
}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export async function fetchReservations(conn: MiniHotelConnection, from: string, to: string): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const url = `${ep.content}/api/Agents/Sci/Reservation/GetReservationKey`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildReservationsRequest(conn, from, to),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    const err = text.match(/ERR\s?\d+[^<\n]*/i);
    if (err) throw new Error(`MiniHotel ${err[0].trim()}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncBookingsFromMiniHotel(opts: {
  from?: string;
  to?: string;
  days?: number;
  xml?: string;
}): Promise<BookingSyncResult> {
  const conn = getMiniHotelConnection();
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : todayUTC();
  const from =
    opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)
      ? opts.from
      : plusDays(to, -(Math.max(1, Math.min(365, opts.days ?? 30)) - 1));

  let xml = opts.xml;
  if (!xml) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return {
        ok: false,
        from,
        to,
        parsed: 0,
        mapped: 0,
        stored: 0,
        unmappedTypes: [],
        message: "MiniHotel connection isn't configured — set username, password and hotel id in Settings first.",
      };
    }
    xml = await fetchReservations(conn, from, to);
  }

  const parsed = parseReservations(xml);

  // RoomTypeCode -> unit id (case-insensitive), same mapping as the ARI sync.
  const byType = new Map<string, string>();
  for (const r of getMiniHotelMapping()) {
    if (r.roomType) byType.set(r.roomType.trim().toUpperCase(), r.unitId);
  }

  const unmapped = new Set<string>();
  let mapped = 0;
  let stored = 0;
  for (const r of parsed) {
    const unitId = r.roomType ? byType.get(r.roomType.trim().toUpperCase()) ?? null : null;
    if (r.roomType && !unitId) unmapped.add(r.roomType);
    if (unitId) mapped++;
    upsertBooking(reservationToBooking(r, unitId));
    stored++;
  }

  return { ok: true, from, to, parsed: parsed.length, mapped, stored, unmappedTypes: [...unmapped].sort() };
}
