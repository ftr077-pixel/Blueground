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

/**
 * Parse a GetReservationKey <Bookings> response into flat reservations.
 *
 * Multi-room (group) bookings — one <Booking> with several <RoomStay
 * memberSerial=…> rows, each with its own <StayDate>/<Total>/<GuestCount>,
 * while the booking-level <Total> ships EMPTY — are expanded to one
 * reservation per room, id'd `<bookingId>:<memberSerial>`. A room without its
 * own total gets a nights-proportional share of the booking total. Collapsing
 * a group into one row would drop all but the first room's nights and (since
 * the global total is empty) its money entirely.
 */
export function parseReservations(xml: string): ParsedReservation[] {
  const out: ParsedReservation[] = [];
  const bRe = /<Booking\b([^>]*)>([\s\S]*?)<\/Booking>/gi;
  let b: RegExpExecArray | null;
  while ((b = bRe.exec(xml))) {
    const head = b[1];
    const body = b[2];
    const minihotelId = attr(head, "Minihotel_reservation_id");
    if (!minihotelId) continue;

    // Prefer the ResGlobalInfo totals/dates; fall back to the first occurrence.
    const rgi = /<ResGlobalInfo\b[^>]*>([\s\S]*?)<\/ResGlobalInfo>/i.exec(body);
    const scope = rgi ? rgi[1] : body;
    const span = /<Timespan\b([^>]*)\/?>/i.exec(scope) ?? /<Timespan\b([^>]*)\/?>/i.exec(body);
    const total = /<Total\b([^>]*)\/?>/i.exec(scope) ?? /<Total\b([^>]*)\/?>/i.exec(body);
    const guests = /<GuestCount\b([^>]*)\/?>/i.exec(scope) ?? /<GuestCount\b([^>]*)\/?>/i.exec(body);

    const shared = {
      portalId: attr(head, "Portal_reservation_id"),
      source: attr(head, "source"),
      status: attr(head, "Status"),
      createdOn: toIso(attr(head, "createDateTime")),
    };
    const arrival = span ? toIso(attr(span[1], "arrival")) : null;
    const departure = span ? toIso(attr(span[1], "departure")) : null;
    // Number("") is 0 — an empty AmountAfterTaxes (group bookings) must be null.
    const globalTotal = total ? numAttr(total[1], "AmountAfterTaxes") : null;
    const currency = total ? attr(total[1], "CurrencyCode") : null;

    // Every <RoomStay> with its per-room fields (group members can differ).
    const stays: Array<{
      serial: string | null;
      roomType: string | null;
      arrival: string | null;
      departure: string | null;
      total: number | null;
      currency: string | null;
      guests: number | null;
    }> = [];
    const rsRe = /<RoomStay\b([^>]*?)(?:\/>|>([\s\S]*?)<\/RoomStay>)/gi;
    let rs: RegExpExecArray | null;
    while ((rs = rsRe.exec(body))) {
      const attrs = rs[1] ?? "";
      const inner = rs[2] ?? "";
      const sd = /<StayDate\b([^>]*)\/?>/i.exec(inner) ?? /<Timespan\b([^>]*)\/?>/i.exec(inner);
      const t = /<Total\b([^>]*)\/?>/i.exec(inner);
      const g = /<GuestCount\b([^>]*)\/?>/i.exec(inner);
      const adult = g ? numAttr(g[1], "adult") ?? 0 : 0;
      const child = g ? numAttr(g[1], "child") ?? 0 : 0;
      stays.push({
        serial: attr(attrs, "memberSerial"),
        roomType: attr(attrs, "roomTypeId") ?? attr(attrs, "roomTypeID"),
        arrival: sd ? toIso(attr(sd[1], "arrival")) : null,
        departure: sd ? toIso(attr(sd[1], "departure")) : null,
        total: t ? numAttr(t[1], "AmountAfterTaxes") : null,
        currency: t ? attr(t[1], "CurrencyCode") : null,
        guests: adult + child || null,
      });
    }

    if (stays.length > 1) {
      // ---- multi-room (group): one reservation per room ----------------------
      const nightsOf = (s: (typeof stays)[number]): number =>
        Math.max(0, daysBetween(s.arrival ?? arrival, s.departure ?? departure) ?? 0);
      const known = stays.reduce((s, r) => s + (r.total ?? 0), 0);
      const missingNights = stays.filter((r) => r.total == null).reduce((s, r) => s + nightsOf(r), 0);
      const leftover = globalTotal != null ? Math.max(0, globalTotal - known) : null;
      const memberSeen = new Set<string>();
      for (let i = 0; i < stays.length; i++) {
        const r = stays[i];
        let roomTotal = r.total;
        if (roomTotal == null && leftover != null && missingNights > 0) {
          roomTotal = (leftover * nightsOf(r)) / missingNights;
        }
        let member = r.serial || String(i + 1);
        while (memberSeen.has(member)) member += `-${i + 1}`;
        memberSeen.add(member);
        out.push({
          minihotelId: `${minihotelId}:${member}`,
          ...shared,
          arrival: r.arrival ?? arrival,
          departure: r.departure ?? departure,
          roomType: r.roomType,
          guests: r.guests,
          total: roomTotal,
          currency: r.currency ?? currency,
        });
      }
      continue;
    }

    // ---- single room: the original whole-booking row -------------------------
    const adult = guests ? numAttr(guests[1], "adult") ?? 0 : 0;
    const child = guests ? numAttr(guests[1], "child") ?? 0 : 0;
    out.push({
      minihotelId,
      ...shared,
      arrival,
      departure,
      roomType: stays[0]?.roomType ?? null,
      guests: adult + child || null,
      total: globalTotal ?? stays[0]?.total ?? null,
      currency: currency ?? stays[0]?.currency ?? null,
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
