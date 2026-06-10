// Pure parsing/mapping for MiniHotel GetReservationKey responses — no IO, so it
// is unit-testable in isolation. The sync (minihotel-bookings.ts) adds fetch +
// DB writes on top.

import type { MiniHotelConnection } from "@/lib/repos/integrations";
import type { Booking } from "@/lib/repos/bookings";

export interface ParsedReservation {
  minihotelId: string;
  portalId: string | null;
  source: string | null;
  status: string | null;
  createdOn: string | null;
  arrival: string | null;
  departure: string | null;
  roomType: string | null;
  guests: number | null;
  total: number | null;
  currency: string | null;
}

export function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attr(s: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(s);
  return m ? m[1] : null;
}
function numAttr(s: string, name: string): number | null {
  const v = attr(s, name);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// MiniHotel uses dd/MM/yyyy in reservation responses; accept yyyy-MM-dd too.
export function toIso(s: string | null): string | null {
  if (!s) return null;
  let m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const t0 = Date.parse(`${a}T00:00:00Z`);
  const t1 = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.round((t1 - t0) / 86_400_000);
}

export function buildReservationsRequest(conn: MiniHotelConnection, from: string, to: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    "<GetReservationKey>" +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<CreateDate From="${from}" To="${to}" />` +
    "<IncludeRoomPrices>true</IncludeRoomPrices>" +
    "</GetReservationKey>"
  );
}

/** Parse a GetReservationKey <Bookings> response into flat reservations. */
export function parseReservations(xml: string): ParsedReservation[] {
  const out: ParsedReservation[] = [];
  const bRe = /<Booking\b([^>]*)>([\s\S]*?)<\/Booking>/gi;
  let b: RegExpExecArray | null;
  while ((b = bRe.exec(xml))) {
    const head = b[1];
    const body = b[2];
    const minihotelId = attr(head, "Minihotel_reservation_id");
    if (!minihotelId) continue;

    // First room stay's type (vacation rentals are typically single-room).
    const roomStay = /<RoomStay\b([^>]*)\/?>/i.exec(body);
    const roomType = roomStay ? attr(roomStay[1], "roomTypeId") ?? attr(roomStay[1], "roomTypeID") : null;

    // Prefer the ResGlobalInfo totals/dates; fall back to the first occurrence.
    const rgi = /<ResGlobalInfo\b[^>]*>([\s\S]*?)<\/ResGlobalInfo>/i.exec(body);
    const scope = rgi ? rgi[1] : body;
    const span = /<Timespan\b([^>]*)\/?>/i.exec(scope) ?? /<Timespan\b([^>]*)\/?>/i.exec(body);
    const total = /<Total\b([^>]*)\/?>/i.exec(scope) ?? /<Total\b([^>]*)\/?>/i.exec(body);
    const guests = /<GuestCount\b([^>]*)\/?>/i.exec(scope) ?? /<GuestCount\b([^>]*)\/?>/i.exec(body);

    const adult = guests ? numAttr(guests[1], "adult") ?? 0 : 0;
    const child = guests ? numAttr(guests[1], "child") ?? 0 : 0;

    out.push({
      minihotelId,
      portalId: attr(head, "Portal_reservation_id"),
      source: attr(head, "source"),
      status: attr(head, "Status"),
      createdOn: toIso(attr(head, "createDateTime")),
      arrival: span ? toIso(attr(span[1], "arrival")) : null,
      departure: span ? toIso(attr(span[1], "departure")) : null,
      roomType,
      guests: adult + child || null,
      total: total ? numAttr(total[1], "AmountAfterTaxes") : null,
      currency: total ? attr(total[1], "CurrencyCode") : null,
    });
  }
  return out;
}

/** Convert a parsed reservation + resolved unit into a Booking row. */
export function reservationToBooking(r: ParsedReservation, unitId: string | null): Booking {
  const nights = daysBetween(r.arrival, r.departure);
  const nightly = r.total != null && nights && nights > 0 ? r.total / nights : null;
  return {
    id: r.minihotelId,
    portalResId: r.portalId,
    unitId,
    roomType: r.roomType,
    source: r.source,
    status: r.status,
    createdOn: r.createdOn,
    arrival: r.arrival,
    departure: r.departure,
    nights,
    guests: r.guests,
    total: r.total,
    nightly: nightly != null ? Math.round(nightly) : null,
    currency: r.currency,
    leadDays: daysBetween(r.createdOn, r.arrival),
  };
}
