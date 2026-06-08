import {
  getMiniHotelConnection,
  getMiniHotelMapping,
  miniHotelEndpoints,
  type MiniHotelConnection,
} from "@/lib/repos/integrations";
import { upsertOverride } from "@/lib/repos/rates";
import { upsertImportedUnit, deleteUnitsByIdPrefix } from "@/lib/repos/units";
import { upsertReservations, reservationStats } from "@/lib/repos/reservations";

/**
 * MiniHotel read sync (server-side).
 *
 * Pulls Bulk ARI (price / availability / min-nights / closures) from MiniHotel,
 * maps each RoomTypeCode to the Hub unit(s) via the apartment mapping, and writes
 * the cells into the Rates Calendar as overrides (source = "minihotel").
 *
 * MiniHotel is a plain authenticated XML API, so the Hub server (running on the
 * box) calls it directly — no separate scraper process needed.
 */

export interface AriCell {
  roomType: string;
  date: string; // YYYY-MM-DD
  price?: number;
  available?: number;
  minNights?: number;
  closed?: boolean;
}

export interface SyncResult {
  ok: boolean;
  from: string;
  days: number;
  roomTypes: number; // distinct room types in the response
  mappedTypes: number; // of those, how many are mapped to a unit
  cells: number; // day-rows parsed
  written: number; // overrides written
  unmappedTypes: string[];
  errors: string[]; // ERR codes MiniHotel reported (non-fatal — skipped, not thrown)
  message?: string;
}

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// MiniHotel responses are entity-encoded XML (their docs ship an UnEscapeXml
// helper), and .asmx endpoints can wrap the payload in <string>…</string> with
// the inner XML encoded. Decode before parsing so tags are real. Mirrors
// MiniHotel's own decoder (the same five named entities); &amp; is done last.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function buildBulkAriRequest(conn: MiniHotelConnection, from: string, to: string): string {
  const rateCode = conn.rateCode || "USD";
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    '<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" ResponseType="05" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<DateRange from="${from}" to="${to}" />` +
    `<Prices rateCode="${escXml(rateCode)}"></Prices>` +
    "</AvailRaterq>"
  );
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
const truthy = (v: string | null) => v != null && /^(yes|true|1|y)$/i.test(v.trim());

/** Parse a Bulk ARI <AvailRaters> response into flat per-room-type/day cells. */
export function parseBulkAri(xml: string): AriCell[] {
  const cells: AriCell[] = [];
  const x = decodeEntities(xml);
  const rtRe = /<RoomType\b([^>]*)>([\s\S]*?)<\/RoomType>/gi;
  let rt: RegExpExecArray | null;
  while ((rt = rtRe.exec(x))) {
    const code = attr(rt[1], "id");
    if (!code) continue;
    const dayRe = /<Day\b([^>]*)>/gi;
    let d: RegExpExecArray | null;
    while ((d = dayRe.exec(rt[2]))) {
      const a = d[1];
      const mdate = attr(a, "Mdate");
      if (!mdate || mdate.length !== 8) continue;
      const cell: AriCell = {
        roomType: code,
        date: `${mdate.slice(0, 4)}-${mdate.slice(4, 6)}-${mdate.slice(6, 8)}`,
      };
      const price = numAttr(a, "Mprice");
      if (price != null) cell.price = Math.round(price);
      const avail = numAttr(a, "Mavailability");
      if (avail != null) cell.available = Math.round(avail);
      const minn = numAttr(a, "Minngt");
      if (minn != null && minn > 0) cell.minNights = Math.round(minn);
      const mclose = attr(a, "Mclose");
      if (mclose != null) cell.closed = truthy(mclose);
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * Extract any ERR codes MiniHotel embeds in a response. These are collected and
 * reported, never thrown — one misconfigured room type (e.g. "ERR 310: Basic
 * occupancy is missing…") shouldn't block the rest of the sync.
 */
export function parseAriErrors(xml: string): string[] {
  const out: string[] = [];
  const re = /ERR\s?\d+[^<\n]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[0].trim());
  return out;
}

export async function fetchBulkAri(conn: MiniHotelConnection, from: string, to: string): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildBulkAriRequest(conn, from, to),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    // Embedded ERR codes are returned (not thrown) so the caller can keep any
    // valid data and collect the issues, instead of hard-failing the whole sync.
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncFromMiniHotel(opts: {
  from?: string;
  days?: number;
  xml?: string; // optional captured response — parse this instead of calling MiniHotel
}): Promise<SyncResult> {
  const conn = getMiniHotelConnection();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayUTC();
  const days = Math.max(1, Math.min(120, opts.days ?? 60));
  const to = plusDays(from, days - 1);

  let xml = opts.xml;
  if (!xml) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return {
        ok: false,
        from,
        days,
        roomTypes: 0,
        mappedTypes: 0,
        cells: 0,
        written: 0,
        unmappedTypes: [],
        errors: [],
        message: "MiniHotel connection isn't configured — set username, password and hotel id in Settings first.",
      };
    }
    xml = await fetchBulkAri(conn, from, to);
  }

  const parsed = parseBulkAri(xml);
  const errors = parseAriErrors(xml);

  // RoomTypeCode -> unit id(s); case-insensitive so codes match regardless of casing.
  const byType = new Map<string, string[]>();
  for (const r of getMiniHotelMapping()) {
    if (!r.roomType) continue;
    const k = r.roomType.trim().toUpperCase();
    const arr = byType.get(k);
    if (arr) arr.push(r.unitId);
    else byType.set(k, [r.unitId]);
  }

  const typesSeen = new Set<string>();
  const unmapped = new Set<string>();
  let written = 0;
  for (const c of parsed) {
    typesSeen.add(c.roomType);
    const units = byType.get(c.roomType.trim().toUpperCase());
    if (!units || units.length === 0) {
      unmapped.add(c.roomType);
      continue;
    }
    const closed = c.closed ?? false;
    // For a single apartment, availability 0 (and not closed) means the night is sold.
    const booked = c.available != null ? !closed && c.available <= 0 : undefined;
    for (const unitId of units) {
      upsertOverride(
        unitId,
        c.date,
        { price: c.price, available: c.available, minNights: c.minNights, closed: c.closed, booked },
        "minihotel",
      );
      written++;
    }
  }

  return {
    ok: true,
    from,
    days,
    roomTypes: typesSeen.size,
    mappedTypes: typesSeen.size - unmapped.size,
    cells: parsed.length,
    written,
    unmappedTypes: [...unmapped].sort(),
    errors,
  };
}

// ----------------------------------------------------- apartment import
export interface RoomTypeInfo {
  code: string;
  description: string;
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  removedDemo: number;
  apartments: { id: string; name: string; code: string }[];
  errors: string[];
  message?: string;
}

export function buildRoomTypesRequest(conn: MiniHotelConnection): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Request><Settings name="getRoomTypes">' +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}"/>` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    "</Settings></Request>"
  );
}

/** Parse a getRoomTypes response (<ArrayOfRoomTypes><RoomTypes><Type/><Description/>…). */
export function parseRoomTypes(xml: string): RoomTypeInfo[] {
  // Decode first (responses are entity-encoded / may be <string>-wrapped), scope
  // to the ArrayOfRoomTypes block when present, then pull each Type + optional
  // Description. Pairing on Type→Description is robust to the container's name.
  const decoded = decodeEntities(xml);
  const scope =
    decoded.match(/<ArrayOfRoomTypes\b[^>]*>([\s\S]*?)<\/ArrayOfRoomTypes>/i)?.[1] ?? decoded;
  const out: RoomTypeInfo[] = [];
  const re = /<Type>([\s\S]*?)<\/Type>\s*(?:<Description>([\s\S]*?)<\/Description>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const code = (m[1] ?? "").trim();
    if (!code) continue;
    const desc = (m[2] ?? "").trim();
    out.push({ code, description: desc || code });
  }
  return out;
}

/** Discover room types (code + name) from an ARI Bulk response's <RoomType id RoomName>. */
export function parseAriRoomTypes(xml: string): RoomTypeInfo[] {
  const x = decodeEntities(xml);
  const seen = new Map<string, string>();
  const re = /<RoomType\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const code = (attr(m[1], "id") ?? "").trim();
    if (!code || seen.has(code)) continue;
    const name = (attr(m[1], "RoomName") ?? attr(m[1], "Name") ?? "").trim();
    seen.set(code, name || code);
  }
  return [...seen].map(([code, description]) => ({ code, description }));
}

export async function fetchRoomTypes(conn: MiniHotelConnection): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const url = `${ep.content}/agents/ws/settings/rooms/RoomsMain.asmx/getRoomTypes`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildRoomTypesRequest(conn),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Import the hotel's room types from MiniHotel as real Hub apartments, each
 * auto-mapped to its MiniHotel code. Optionally removes the demo seed units
 * (ids prefixed "BG-"). Rates fill in when the operator runs Sync.
 */
export async function importApartmentsFromMiniHotel(opts: {
  xml?: string;
  replaceDemo?: boolean;
}): Promise<ImportResult> {
  const conn = getMiniHotelConnection();
  if (!opts.xml && (!conn.username || !conn.password || !conn.hotelId)) {
    return {
      ok: false,
      imported: 0,
      removedDemo: 0,
      apartments: [],
      errors: [],
      message: "MiniHotel connection isn't configured — set it in Settings first.",
    };
  }

  const snip = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim().slice(0, 200);
  const errors: string[] = [];
  let types: RoomTypeInfo[] = [];
  let snippet = "";

  if (opts.xml) {
    snippet = snip(opts.xml);
    errors.push(...parseAriErrors(opts.xml));
    // Accept either a getRoomTypes response or an ARI feed.
    types = parseRoomTypes(opts.xml);
    if (types.length === 0) types = parseAriRoomTypes(opts.xml);
  } else {
    // 1) Content & Data API getRoomTypes — richest (has descriptions), but needs
    //    Content-API access.
    try {
      const cx = await fetchRoomTypes(conn);
      snippet = snip(cx);
      types = parseRoomTypes(cx);
      if (types.length === 0) errors.push(...parseAriErrors(cx));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "getRoomTypes failed");
    }
    // 2) Fall back to the room types embedded in the ARI feed. This works for
    //    ARI-only accounts, where the Content API returns S009 (Invalid
    //    credentials) — the same access that already powers the rate Sync.
    if (types.length === 0) {
      try {
        const ax = await fetchBulkAri(conn, todayUTC(), plusDays(todayUTC(), 1));
        const ariTypes = parseAriRoomTypes(ax);
        if (ariTypes.length > 0) {
          types = ariTypes;
          errors.length = 0; // ARI succeeded; the Content-API error is moot
        } else {
          snippet = snip(ax);
          errors.push(...parseAriErrors(ax));
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "ARI fallback failed");
      }
    }
  }

  if (types.length === 0) {
    return {
      ok: false,
      imported: 0,
      removedDemo: 0,
      apartments: [],
      errors,
      message: errors.length
        ? `Couldn't read apartments — MiniHotel said: ${errors.join(" | ")}`
        : `No room types found. Response began: ${snippet}`,
    };
  }

  const apartments = types.map((t) => ({ id: `MH-${t.code}`, name: t.description, code: t.code }));
  for (const a of apartments) {
    upsertImportedUnit({ id: a.id, name: a.name, platform: "MiniHotel", minihotelRoomType: a.code });
  }
  const removedDemo = opts.replaceDemo ? deleteUnitsByIdPrefix("BG-") : 0;

  return { ok: true, imported: apartments.length, removedDemo, apartments, errors };
}

// ============================================================ reservations (actuals)
//
// Real revenue actuals come from the actual bookings, not ARI availability. The
// Content & Data API returns reservations with room prices; we parse them, store
// them, and recognize the revenue per night (see repos/reservations). There are
// no costs in MiniHotel, so this feeds rental-revenue actuals only.
//
// The parser is deliberately tolerant (MiniHotel's reservation schema varies by
// account), and the direct-pull request is best-effort — the guaranteed-stable
// seam is the box reader POSTing clean rows to /api/reservations/snapshot, exactly
// like the ARI snapshot. Either way the data lands in the same place.

export interface MiniReservation {
  id: string;
  roomType?: string;
  roomNumber?: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD, exclusive
  gross: number; // AmountAfterTaxes — tax-INCLUSIVE; the repo strips VAT to net
  currency?: string;
  country?: string; // guest country (iso2/iso3/name) — drives VAT-net
  status?: string;
}

// Field aliases for the generic JSON path, normalized to lowercase, separators stripped.
const RF = {
  id: ["minihotelreservationid", "reservationid", "resid", "id", "reservationkey", "key", "confirmation", "bookingid", "portalreservationid"],
  checkIn: ["checkin", "arrival", "arrivaldate", "from", "fromdate", "startdate", "datein"],
  checkOut: ["checkout", "departure", "departuredate", "to", "todate", "enddate", "dateout"],
  gross: ["amountaftertaxes", "roomrevenue", "totalroomprice", "totalprice", "total", "gross", "revenue", "price", "amount", "grandtotal"],
  status: ["status", "state", "reservationstatus"],
  roomType: ["roomtypeid", "roomtype", "roomtypecode", "roomcode"],
  roomNumber: ["roomnumber", "roomno", "room"],
  country: ["country", "countryname", "countrycode", "iso2", "iso3", "nationality", "residency"],
  currency: ["currencycode", "currency", "cur"],
} as const;

function normDate(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t); // YYYYMMDD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t); // DD/MM/YYYY (MiniHotel is non-US)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = Date.parse(t);
  return Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : null;
}
function normNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function pickCI(obj: Record<string, unknown>, names: readonly string[]): unknown {
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((key) => key.toLowerCase().replace(/[_\s-]/g, "") === n);
    if (k != null && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}
function xmlField(block: string, names: readonly string[]): string | null {
  for (const n of names) {
    const a = new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, "i").exec(block);
    if (a && a[1] !== "") return a[1];
    const e = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (e && e[1].trim() !== "") return e[1].trim();
  }
  return null;
}

function parseReservationsJson(data: unknown): MiniReservation[] {
  let arr: unknown[] = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const k = Object.keys(o).find((key) => Array.isArray(o[key]));
    if (k) arr = o[k] as unknown[];
  }
  const out: MiniReservation[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const checkIn = normDate(pickCI(o, RF.checkIn) as string);
    const checkOut = normDate(pickCI(o, RF.checkOut) as string);
    const gross = normNum(pickCI(o, RF.gross) as string | number);
    if (!checkIn || !checkOut || gross == null) continue;
    const id = pickCI(o, RF.id);
    out.push({
      id: id != null ? String(id) : `${checkIn}_${out.length}`,
      checkIn,
      checkOut,
      gross,
      roomType: (pickCI(o, RF.roomType) as string) || undefined,
      roomNumber: (pickCI(o, RF.roomNumber) as string) || undefined,
      country: (pickCI(o, RF.country) as string) || undefined,
      status: (pickCI(o, RF.status) as string) || undefined,
      currency: (pickCI(o, RF.currency) as string) || undefined,
    });
  }
  return out;
}

const firstBlock = (re: RegExp, s: string): string => re.exec(s)?.[1] ?? "";

/**
 * Parse MiniHotel's GetReservationKey response (§3.3): one <Booking> per reservation,
 * with the whole-stay total in <ResGlobalInfo><Total AmountAfterTaxes>, dates in
 * <Timespan arrival departure> (dd/mm/yyyy), the room in the first <RoomStay>, and the
 * guest country in <PrimaryGuest><Country>. The total is tax-INCLUSIVE; VAT is derived
 * downstream from the country.
 */
function parseBookingsXml(xml: string): MiniReservation[] {
  const out: MiniReservation[] = [];
  const re = /<Booking\b([^>]*)>([\s\S]*?)<\/Booking>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const head = m[1];
    const inner = m[2];
    const ts = firstBlock(/<Timespan\b([^>]*?)\/?>/i, inner) || firstBlock(/<StayDate\b([^>]*?)\/?>/i, inner);
    const checkIn = normDate(attr(ts, "arrival"));
    const checkOut = normDate(attr(ts, "departure"));
    // Prefer the booking-level total (ResGlobalInfo); fall back to the first RoomStay total.
    const totalScope = firstBlock(/<ResGlobalInfo\b[^>]*>([\s\S]*?)<\/ResGlobalInfo>/i, inner) || inner;
    const total = firstBlock(/<Total\b([^>]*?)\/?>/i, totalScope);
    const gross = normNum(attr(total, "AmountAfterTaxes") ?? attr(total, "value"));
    if (!checkIn || !checkOut || gross == null) continue;
    const stay = firstBlock(/<RoomStay\b([^>]*?)\/?>/i, inner);
    const country = firstBlock(/<Country\b([^>]*?)\/?>/i, inner);
    out.push({
      id:
        attr(head, "Minihotel_reservation_id") ||
        attr(head, "Portal_reservation_id") ||
        `${checkIn}_${out.length}`,
      checkIn,
      checkOut,
      gross,
      roomType: attr(stay, "roomTypeId") || attr(stay, "roomTypeID") || undefined,
      roomNumber: attr(stay, "roomNumber") || undefined,
      country: attr(country, "iso2") || attr(country, "iso3") || attr(country, "CountryName") || undefined,
      currency: attr(total, "CurrencyCode") || undefined,
      status: attr(head, "Status") || undefined,
    });
  }
  return out;
}

/** Generic <Reservation>/<Booking>/<Res> fallback for non-standard XML shapes. */
function parseReservationsXml(xml: string): MiniReservation[] {
  const out: MiniReservation[] = [];
  const x = decodeEntities(xml);
  const re = /<(Reservation|Booking|Res)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const block = m[2] + m[3]; // attributes + inner elements
    const checkIn = normDate(xmlField(block, RF.checkIn));
    const checkOut = normDate(xmlField(block, RF.checkOut));
    const gross = normNum(xmlField(block, RF.gross));
    if (!checkIn || !checkOut || gross == null) continue;
    out.push({
      id: xmlField(block, RF.id) || `${checkIn}_${out.length}`,
      checkIn,
      checkOut,
      gross,
      roomType: xmlField(block, RF.roomType) || undefined,
      roomNumber: xmlField(block, RF.roomNumber) || undefined,
      country: xmlField(block, RF.country) || undefined,
      status: xmlField(block, RF.status) || undefined,
      currency: xmlField(block, RF.currency) || undefined,
    });
  }
  return out;
}

/** Parse a MiniHotel reservations response (JSON, GetReservationKey XML, or generic). */
export function parseReservations(payload: string): MiniReservation[] {
  const t = payload.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return parseReservationsJson(JSON.parse(t));
    } catch {
      /* not JSON after all — fall through to XML */
    }
  }
  if (/<Booking\b/i.test(t)) {
    const bookings = parseBookingsXml(t);
    if (bookings.length) return bookings;
  }
  return parseReservationsXml(t);
}

/** GetReservationKey request (§3.3) — filter by arrival date, include room prices. */
export function buildReservationsRequest(conn: MiniHotelConnection, from: string, to: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    "<GetReservationKey>" +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<ArrivalDate From="${from}" To="${to}" />` +
    "<IncludeRoomPrices>true</IncludeRoomPrices>" +
    "</GetReservationKey>"
  );
}

export async function fetchReservations(conn: MiniHotelConnection, from: string, to: string): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${ep.content}/api/Agents/Sci/Reservation/GetReservationKey`, {
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

export interface ReservationSyncResult {
  ok: boolean;
  from: string;
  to: string;
  parsed: number; // reservations parsed from the response
  recorded: number; // stored
  skipped: number; // unparseable rows dropped
  counted: number; // non-cancelled, non-test reservations now on file
  test: number; // excluded as test apartments
  months: number; // distinct months with revenue
  revenue: number; // total counted NET revenue, ILS
  vat: number; // total VAT stripped out
  message?: string;
}

export async function syncReservationsFromMiniHotel(opts: {
  from?: string;
  days?: number;
  payload?: string; // captured response — parse this instead of calling MiniHotel
}): Promise<ReservationSyncResult> {
  const conn = getMiniHotelConnection();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayUTC();
  const days = Math.max(1, Math.min(370, opts.days ?? 120));
  const to = plusDays(from, days - 1);

  let payload = opts.payload;
  if (!payload) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return {
        ok: false,
        from,
        to,
        parsed: 0,
        recorded: 0,
        skipped: 0,
        counted: 0,
        test: 0,
        months: 0,
        revenue: 0,
        vat: 0,
        message: "MiniHotel connection isn't configured — set username, password and hotel id in Settings first.",
      };
    }
    payload = await fetchReservations(conn, from, to);
  }

  const parsed = parseReservations(payload);
  const { recorded, skipped } = upsertReservations(
    parsed.map((r) => ({
      id: r.id,
      roomType: r.roomType,
      roomNumber: r.roomNumber,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      gross: r.gross, // tax-inclusive — upsertReservations derives net from country
      country: r.country,
      currency: r.currency,
      status: r.status,
    })),
  );
  const stats = reservationStats();
  return {
    ok: true,
    from,
    to,
    parsed: parsed.length,
    recorded,
    skipped,
    counted: stats.count,
    test: stats.test,
    months: stats.months,
    revenue: stats.revenue,
    vat: stats.vat,
  };
}
