import {
  getMiniHotelConnection,
  getMiniHotelMapping,
  getExcludedRoomCodes,
  miniHotelEndpoints,
  miniHotelContentAuth,
  type MiniHotelConnection,
} from "@/lib/repos/integrations";
import { upsertOverride, setBookedNights } from "@/lib/repos/rates";
import { upsertImportedUnit, deleteUnitsByIdPrefix } from "@/lib/repos/units";
import { upsertReservations, reservationStats, markReservationsCancelled } from "@/lib/repos/reservations";
import { storeAriOccupancy, occupancyByMonth } from "@/lib/repos/occupancy";
import { getDb } from "@/lib/db";

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
  errors: string[]; // ERR codes MiniHotel reported (non-fatal — collected, not thrown)
  note?: string; // e.g. "loaded via availability search after the bulk feed was blocked"
  reservations?: number; // PMS reservations found in the window (undefined = pull didn't run)
  bookedNights?: number; // sold nights written to the calendar from those reservations
  message?: string;
}

// "Today" on the hotel's calendar (Asia/Jerusalem), not UTC: between local
// midnight and 02:00/03:00 the UTC date is still yesterday, which would shift
// every default sync window a day into the past.
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
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

export function buildBulkAriRequest(
  conn: MiniHotelConnection,
  from: string,
  to: string,
  roomTypeIds?: string[],
): string {
  const rateCode = conn.rateCode || "USD";
  const roomTypes =
    roomTypeIds && roomTypeIds.length
      ? `<RoomTypes>${roomTypeIds.map((id) => `<RoomType id="${escXml(id)}" />`).join("")}</RoomTypes>`
      : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    '<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    // MinimumNights="YES" is opt-in (omitting = "NO"): without it MiniHotel
    // returns Minngt="0" for every day and real min-stay restrictions never sync.
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" ResponseType="05" MinimumNights="YES" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<DateRange from="${from}" to="${to}" />` +
    roomTypes +
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
  // Also accept self-closing <RoomType …/> — with the paired-only pattern an
  // empty self-closed type would swallow its next sibling (everything up to the
  // sibling's </RoomType>) and attribute that sibling's days to the wrong code.
  const rtRe = /<RoomType\b([^>]*?)(?:\/>|>([\s\S]*?)<\/RoomType>)/gi;
  let rt: RegExpExecArray | null;
  while ((rt = rtRe.exec(x))) {
    const code = attr(rt[1], "id");
    if (!code) continue;
    const dayRe = /<Day\b([^>]*)>/gi;
    let d: RegExpExecArray | null;
    while ((d = dayRe.exec(rt[2] ?? ""))) {
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
  // Case-sensitive + word boundary: MiniHotel emits "ERR 310 …" (docs §2.7);
  // a loose match also fires on free text like "Herr 304 wants late checkout".
  const re = /\bERR\s?\d+[^<\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[0].trim());
  return out;
}

/**
 * Errors from any MiniHotel API — ARI "ERR 310 …" codes and Content/Data
 * `<Error code="S009" description="…" />` tags. Decodes entities first.
 */
export function extractMiniHotelErrors(text: string): string[] {
  const x = decodeEntities(text);
  const out: string[] = [];
  const errRe = /\bERR\s?\d+[^<\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = errRe.exec(x))) out.push(m[0].trim());
  const tagRe = /<Error\b[^>]*?code="([^"]*)"(?:[^>]*?description="([^"]*)")?[^>]*>/gi;
  while ((m = tagRe.exec(x))) {
    const desc = (m[2] ?? "").trim();
    out.push(desc ? `${m[1]}: ${desc}` : m[1]);
  }
  return out;
}

export async function fetchBulkAri(
  conn: MiniHotelConnection,
  from: string,
  to: string,
  roomTypeIds?: string[],
): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildBulkAriRequest(conn, from, to, roomTypeIds),
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

/**
 * Build an "Immediate ARI" (guests-based availability search) request. Unlike the
 * bulk feed, this prices rooms FOR a party of N adults, so MiniHotel typically
 * just omits a room type with no Basic occupancy instead of aborting the whole
 * response (ERR 310). Its prices are the TOTAL for the requested stay — call it
 * with a 1-night range to get a per-night price.
 */
export function buildGuestsAvailRequest(
  conn: MiniHotelConnection,
  from: string,
  to: string,
  adults = 2,
): string {
  const rateCode = conn.rateCode || "USD";
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    '<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<DateRange from="${from}" to="${to}" />` +
    `<Guests adults="${adults}" child="" babies="" />` +
    '<RoomTypes><RoomType id="*ALL*" /></RoomTypes>' +
    `<Prices rateCode="${escXml(rateCode)}"><Price boardCode="*ALL*" /></Prices>` +
    "</AvailRaterq>"
  );
}

export interface GuestsAvailRoom {
  roomType: string;
  price: number | null; // lowest board value for the requested stay
  available: number | null;
}

/**
 * Parse an Immediate-ARI response:
 *   <RoomType id …><Inventory Allocation maxavail/><price value …/>…</RoomType>
 * Price = the lowest board value (room-only base); availability = Allocation
 * ("number of available rooms" per the docs — maxavail is the TOTAL room count,
 * so reading it as availability marks sold-out nights as open), falling back to
 * maxavail only when Allocation is absent.
 */
export function parseGuestsAvail(xml: string): GuestsAvailRoom[] {
  const x = decodeEntities(xml);
  const out: GuestsAvailRoom[] = [];
  const rtRe = /<RoomType\b([^>]*?)(?:\/>|>([\s\S]*?)<\/RoomType>)/gi;
  let rt: RegExpExecArray | null;
  while ((rt = rtRe.exec(x))) {
    const code = attr(rt[1], "id");
    if (!code) continue;
    const body = rt[2] ?? "";
    let price: number | null = null;
    const pRe = /<price\b([^>]*?)\/?>/gi;
    let p: RegExpExecArray | null;
    while ((p = pRe.exec(body))) {
      const v = numAttr(p[1], "value");
      if (v != null && (price == null || v < price)) price = v;
    }
    const inv = body.match(/<Inventory\b([^>]*?)\/?>/i);
    let available: number | null = null;
    if (inv) {
      available = numAttr(inv[1], "Allocation");
      if (available == null) available = numAttr(inv[1], "maxavail");
    }
    out.push({ roomType: code, price: price != null ? Math.round(price) : null, available });
  }
  return out;
}

export async function fetchGuestsAvail(
  conn: MiniHotelConnection,
  from: string,
  to: string,
  adults = 2,
): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildGuestsAvailRequest(conn, from, to, adults),
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
 * Fallback used when the bulk feed is blocked: walk the window one night at a
 * time via the guests-based search (its price is per-stay, so a 1-night range =
 * nightly). Bails immediately if the first night yields nothing, so a dead end
 * never costs a long loop; capped so even a working fallback stays responsive.
 */
async function fetchGuestsFallback(
  conn: MiniHotelConnection,
  from: string,
  days: number,
): Promise<{ cells: AriCell[]; errors: string[]; nights: number }> {
  const cells: AriCell[] = [];
  const errs = new Set<string>();
  const horizon = Math.min(days, 35);
  let nights = 0;
  for (let i = 0; i < horizon; i++) {
    const d = plusDays(from, i);
    let rooms: GuestsAvailRoom[];
    try {
      const xml = await fetchGuestsAvail(conn, d, plusDays(d, 1));
      parseAriErrors(xml).forEach((e) => errs.add(e));
      rooms = parseGuestsAvail(xml);
    } catch (e) {
      errs.add(e instanceof Error ? e.message : "availability search failed");
      if (i === 0) break; // can't even reach it — stop
      continue;
    }
    if (rooms.length === 0) {
      if (i === 0) break; // this endpoint can't help either — don't loop 35×
      continue;
    }
    nights++;
    for (const r of rooms) {
      const cell: AriCell = { roomType: r.roomType, date: d };
      if (r.price != null) cell.price = r.price;
      if (r.available != null) cell.available = r.available;
      cells.push(cell);
    }
  }
  return { cells, errors: [...errs], nights };
}

export async function syncFromMiniHotel(opts: {
  from?: string;
  days?: number;
  xml?: string; // optional captured response — parse this instead of calling MiniHotel
}): Promise<SyncResult> {
  const conn = getMiniHotelConnection();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayLocal();
  const days = Math.max(1, Math.min(120, opts.days ?? 60));
  const to = plusDays(from, days - 1);

  let parsed: AriCell[];
  let errors: string[];
  let note: string | undefined;
  // Sold nights per RoomTypeCode from the PMS reservation list (null = the
  // reservation pull didn't run / returned nothing usable — leave booked flags
  // to the availability inference rather than wiping them on a failed pull).
  let soldByType: Map<string, Set<string>> | null = null;
  let reservationsSeen = 0;
  if (opts.xml) {
    parsed = parseBulkAri(opts.xml);
    errors = parseAriErrors(opts.xml);
  } else {
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
    // 1) Whole-hotel bulk feed (per-night grid). It can't be scoped to specific
    //    rooms, so one room type with missing Basic occupancy aborts it (ERR 310).
    const xml = await fetchBulkAri(conn, from, to);
    parsed = parseBulkAri(xml);
    errors = parseAriErrors(xml);

    // 2) Bulk feed blocked (no cells but an error)? Fall back to the guests-based
    //    availability search, which prices per party and usually skips a
    //    misconfigured room instead of aborting the whole response.
    if (parsed.length === 0 && errors.length > 0) {
      const fb = await fetchGuestsFallback(conn, from, days);
      fb.errors.forEach((e) => {
        if (!errors.includes(e)) errors.push(e);
      });
      if (fb.cells.length > 0) {
        parsed = fb.cells;
        note = `Bulk feed was blocked (${errors[0]}); loaded ${fb.nights} night(s) via the availability search instead.`;
      }
    }

    // 3) Reservations → sold nights. The price feeds say what's for sale; the
    //    PMS reservation list (Room Status Inquiry) says what's actually SOLD.
    //    Pull it for the same window so occupancy reads true all the way out —
    //    independent of bulk-feed blocks or the fallback's night cap.
    try {
      const rxml = await fetchRoomStatusRange(conn, from, to);
      const resv = parseRoomStatusReservations(rxml);
      extractMiniHotelErrors(rxml).forEach((e) => {
        if (!errors.includes(e)) errors.push(e);
      });
      if (resv.length > 0) {
        soldByType = new Map();
        reservationsSeen = 0;
        for (const r of resv) {
          if (!r.roomType) continue;
          if (r.status && /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i.test(r.status)) continue;
          reservationsSeen++;
          const key = r.roomType.trim().toUpperCase();
          let set = soldByType.get(key);
          if (!set) soldByType.set(key, (set = new Set()));
          // checkOut is the departure date — the guest's last NIGHT is the day before.
          for (let d = r.checkIn; d < r.checkOut; d = plusDays(d, 1)) {
            if (d >= from && d <= to) set.add(d);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "reservation pull failed";
      if (!errors.includes(msg)) errors.push(msg);
    }
  }

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
    // Without a reservation list, availability 0 (and not closed) is the best
    // guess for "sold" — but when reservations were pulled (below), THEY are
    // the truth for booked, so the inference stays out of their way.
    const booked =
      soldByType != null ? undefined : c.available != null ? !closed && c.available <= 0 : undefined;
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

  // Reservation truth: mark each mapped unit's sold nights across the WHOLE
  // window (cancellations heal — previously-booked nights with no reservation
  // flip back to open).
  let bookedNights = 0;
  if (soldByType) {
    const windowDates: string[] = [];
    for (let i = 0; i < days; i++) windowDates.push(plusDays(from, i));
    for (const [code, units] of byType) {
      const sold = soldByType.get(code) ?? new Set<string>();
      for (const unitId of units) bookedNights += setBookedNights(unitId, windowDates, sold);
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
    reservations: soldByType ? reservationsSeen : undefined,
    bookedNights: soldByType ? bookedNights : undefined,
    unmappedTypes: [...unmapped].sort(),
    errors,
    note,
  };
}

// ----------------------------------------------------- write (Reverse ARI)
export interface RatePushItem {
  unitId: string;
  date: string; // YYYY-MM-DD
  price?: number | null; // null clears the price; undefined leaves it untouched
  minNights?: number | null;
  closed?: boolean | null;
  available?: number | null;
}

export interface PushResult {
  ok: boolean;
  pushed: number; // dates MiniHotel accepted (best-effort)
  roomTypes: number; // distinct room types in the push
  /** Units in the request with no MiniHotel room-type mapping (skipped). */
  unmappedUnits: number;
  warnings: string[];
  errors: string[];
  requestId?: string; // X-Request-ID — MiniHotel support needs it to trace issues
  message?: string; // set when we didn't even attempt (not configured / unmapped / no rate code)
}

/**
 * Push manual rate/availability/restriction edits INTO MiniHotel via the Reverse
 * API (§4.2: POST JSON to /AgentsScreenA/api/Agents/ScreenA, header auth). Each
 * Hub unit is resolved to its MiniHotel RoomTypeCode via the apartment mapping;
 * the price is written under the saved rate code (PriceList). Per-date problems
 * come back as Warnings/Errors and are surfaced, not thrown.
 */
export async function pushRatesToMiniHotel(items: RatePushItem[]): Promise<PushResult> {
  const empty = {
    pushed: 0,
    roomTypes: 0,
    unmappedUnits: 0,
    warnings: [] as string[],
    errors: [] as string[],
  };
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId)
    return { ok: false, ...empty, message: "MiniHotel connection isn't configured (Settings)." };
  if (!conn.rateCode || conn.rateCode.trim() === "")
    return {
      ok: false,
      ...empty,
      message: "No price-list (rate) code set — Settings → Find rate code. MiniHotel needs the exact code to write a price.",
    };

  // Hub unit -> MiniHotel RoomTypeCode, then group the edits by room type.
  const codeByUnit = new Map<string, string>();
  for (const m of getMiniHotelMapping()) if (m.roomType) codeByUnit.set(m.unitId, m.roomType.trim());
  const byType = new Map<string, RatePushItem[]>();
  const unmapped = new Set<string>();
  for (const it of items) {
    const code = codeByUnit.get(it.unitId);
    if (!code) {
      unmapped.add(it.unitId);
      continue;
    }
    const arr = byType.get(code);
    if (arr) arr.push(it);
    else byType.set(code, [it]);
  }
  if (byType.size === 0)
    return {
      ok: false,
      ...empty,
      unmappedUnits: unmapped.size,
      message: "This apartment isn't mapped to a MiniHotel room type — set its code in Settings → apartment mapping.",
    };

  const body = [...byType.entries()].map(([RoomTypeCode, list]) => ({
    RoomTypeCode,
    Dates: list.map((it) => {
      // Omit fields we don't want to change (per the API contract).
      const d: Record<string, unknown> = { Date: it.date };
      if (it.available != null) d.Availability = it.available;
      // MiniHotel's MinimumNights is min-stay-THROUGH semantics (PriceLabs:
      // "Min-Stay Through — specific to MiniHotel and Lodgify"): the minimum
      // must hold for every stay date, not just check-in.
      if (it.minNights != null) d.MinimumNights = it.minNights;
      if (it.closed != null) d.Close = it.closed;
      if (it.price != null) d.Rates = [{ PriceList: conn.rateCode, Price: it.price }];
      return d;
    }),
  }));

  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.reverse, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        User: conn.username,
        Password: conn.password,
        hotel_id: conn.hotelId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const requestId = res.headers.get("X-Request-ID") ?? undefined;
    const text = await res.text();
    if (!res.ok)
      return {
        ok: false,
        ...empty,
        roomTypes: byType.size,
        unmappedUnits: unmapped.size,
        errors: [`MiniHotel HTTP ${res.status}: ${text.slice(0, 200)}`],
        requestId,
      };
    let warnings: string[] = [];
    let errors: string[] = [];
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.Warnings)) warnings = j.Warnings.map(String);
      if (Array.isArray(j?.Errors)) errors = j.Errors.map(String);
    } catch {
      // Some responses come back as XML; salvage any <Error>/ERR text.
      errors = extractMiniHotelErrors(text);
    }
    const attempted = [...byType.values()].reduce((s, l) => s + l.length, 0);
    return {
      ok: errors.length === 0,
      pushed: errors.length ? Math.max(0, attempted - errors.length) : attempted,
      roomTypes: byType.size,
      unmappedUnits: unmapped.size,
      warnings,
      errors,
      requestId,
    };
  } catch (e) {
    const msg =
      e instanceof Error ? (e.name === "AbortError" ? "MiniHotel timed out" : e.message) : "push failed";
    return { ok: false, ...empty, roomTypes: byType.size, unmappedUnits: unmapped.size, errors: [msg] };
  } finally {
    clearTimeout(timer);
  }
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
  const a = miniHotelContentAuth(conn);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Request><Settings name="getRoomTypes">' +
    `<Authentication username="${escXml(a.username)}" password="${escXml(a.password)}"/>` +
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

function buildRoomStatusRequest(conn: MiniHotelConnection, from: string, to: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    '<AvailRaters xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Authentication username="${escXml(conn.username)}" password="${escXml(conn.password)}" ResponseType="03" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<DateRange from="${from}" to="${to}" />` +
    "</AvailRaters>"
  );
}

/** Real-Time Room Status (ResponseType 03): lists ALL rooms/types, ignoring occupancy/price config. */
export async function fetchRoomStatus(conn: MiniHotelConnection): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildRoomStatusRequest(conn, todayLocal(), plusDays(todayLocal(), 1)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface AriReservation {
  resNumber: string;
  name?: string;
  roomNumber?: string;
  roomType?: string;
  checkIn: string;
  checkOut: string;
  status?: string;
  amount?: number; // present only if this hotel's response carries a price-like field
}

const ymd8 = (s: string | null): string | null => {
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
};

/**
 * Parse the <Reservations> list from a Room Status (ResponseType 03) response on
 * the ARI server. Per MiniHotel's docs this view carries guest/room/dates/status
 * but NO prices, and omits checked-out/cancelled stays — we still surface any
 * price-like attribute in case a given hotel's response happens to include one.
 */
export function parseRoomStatusReservations(xml: string): AriReservation[] {
  const x = decodeEntities(xml);
  const scope = x.match(/<Reservations\b[^>]*>([\s\S]*?)<\/Reservations>/i)?.[1] ?? x;
  const out: AriReservation[] = [];
  const re = /<Reservation\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const a = m[1];
    const checkIn = ymd8(attr(a, "FromYmd") ?? attr(a, "arrival") ?? attr(a, "From"));
    const checkOut = ymd8(attr(a, "ToYmd") ?? attr(a, "departure") ?? attr(a, "To"));
    if (!checkIn || !checkOut) continue;
    const amount =
      numAttr(a, "AmountAfterTaxes") ??
      numAttr(a, "Total") ??
      numAttr(a, "Amount") ??
      numAttr(a, "Price") ??
      numAttr(a, "Rate");
    out.push({
      resNumber: attr(a, "ResNumber") ?? attr(a, "resnumber") ?? "",
      name: [attr(a, "Namep"), attr(a, "Namef")].filter(Boolean).join(" ") || undefined,
      roomNumber: attr(a, "RoomNumber") ?? undefined,
      roomType: attr(a, "RoomType") ?? undefined,
      checkIn,
      checkOut,
      status: attr(a, "Status") ?? undefined,
      amount: amount ?? undefined,
    });
  }
  return out;
}

/** Room Status (ResponseType 03) over an explicit date range, on the ARI server. */
export async function fetchRoomStatusRange(conn: MiniHotelConnection, from: string, to: string): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildRoomStatusRequest(conn, from, to),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export interface AriReservationsResult {
  ok: boolean;
  from: string;
  to: string;
  count: number;
  withAmount: number; // how many reservations carried a price-like field
  sampleRaw?: string; // first <Reservation .../> tag verbatim — to see all fields
  reservations: AriReservation[];
  errors: string[];
  message?: string;
}

/**
 * Probe the ARI server (api.minihotel.cloud) for the reservation list via Room
 * Status Inquiry — the "can we read bookings from the server that already works?"
 * test. Preview only: it does NOT write the P&L, because this ARI view has no
 * revenue. If the response unexpectedly carries prices, withAmount/sampleRaw show it.
 */
export async function pullAriReservations(opts: {
  from?: string;
  days?: number;
  xml?: string;
}): Promise<AriReservationsResult> {
  const conn = getMiniHotelConnection();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayLocal();
  const days = Math.max(1, Math.min(60, opts.days ?? 35));
  const to = plusDays(from, days - 1);

  let xml = opts.xml;
  if (!xml) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return { ok: false, from, to, count: 0, withAmount: 0, reservations: [], errors: [], message: "MiniHotel connection isn't configured." };
    }
    xml = await fetchRoomStatusRange(conn, from, to);
  }

  const errors = extractMiniHotelErrors(xml);
  const all = parseRoomStatusReservations(xml);
  const sampleRaw = (decodeEntities(xml).match(/<Reservation\b[^>]*?\/?>/i)?.[0] ?? "").slice(0, 400) || undefined;
  return {
    ok: true,
    from,
    to,
    count: all.length,
    withAmount: all.filter((r) => r.amount != null).length,
    sampleRaw,
    reservations: all.slice(0, 100),
    errors,
  };
}

/** Room inventory from a Room Status response (<Rooms><Room Number Rmtype/></Rooms>). */
export function parseRoomStatusRooms(xml: string): { roomNumber: string; roomType?: string }[] {
  const x = decodeEntities(xml);
  const scope = x.match(/<Rooms\b[^>]*>([\s\S]*?)<\/Rooms>/i)?.[1] ?? "";
  const out: { roomNumber: string; roomType?: string }[] = [];
  const re = /<Room\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const num = attr(m[1], "Number") ?? attr(m[1], "RoomNumber");
    if (!num) continue;
    out.push({ roomNumber: num, roomType: attr(m[1], "Rmtype") ?? attr(m[1], "RoomType") ?? undefined });
  }
  return out;
}

export interface AriOccupancyResult {
  ok: boolean;
  from: string;
  to: string;
  bookings: number; // stored bookings
  rooms: number; // stored room inventory
  thisMonth: string;
  occupancy: number; // this month, 0..1
  bookedNights: number; // this month
  errors: string[];
  message?: string;
}

/**
 * Sync occupancy from the ARI server (Room Status Inquiry) into the Hub: store the
 * booking snapshot + room inventory, then return this month's occupancy. Uses the
 * credentials that already work for rates. No revenue is involved (ARI has none).
 */
export async function syncAriOccupancy(opts: {
  from?: string;
  days?: number;
  xml?: string;
}): Promise<AriOccupancyResult> {
  const conn = getMiniHotelConnection();
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayLocal();
  const days = Math.max(1, Math.min(60, opts.days ?? 45));
  const to = plusDays(from, days - 1);

  let xml = opts.xml;
  if (!xml) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return { ok: false, from, to, bookings: 0, rooms: 0, thisMonth: "", occupancy: 0, bookedNights: 0, errors: [], message: "MiniHotel connection isn't configured." };
    }
    xml = await fetchRoomStatusRange(conn, from, to);
  }

  const errors = extractMiniHotelErrors(xml);
  const bookings = parseRoomStatusReservations(xml).map((r) => ({
    resNumber: r.resNumber,
    roomNumber: r.roomNumber,
    roomType: r.roomType,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    status: r.status,
  }));
  const rooms = parseRoomStatusRooms(xml);
  // MiniHotel reports failures inside HTTP-200 bodies. A pull that parsed
  // nothing AND carried errors is a failed pull, not an empty hotel — storing
  // it would wipe the previous good snapshot and zero the occupancy KPIs.
  if (bookings.length === 0 && rooms.length === 0 && errors.length > 0) {
    const occ = occupancyByMonth();
    return {
      ok: false,
      from,
      to,
      bookings: 0,
      rooms: 0,
      thisMonth: occ.thisMonth,
      occupancy: occ.current.occupancy,
      bookedNights: occ.current.bookedNights,
      errors,
      message: `MiniHotel returned an error (${errors[0]}) — kept the previous occupancy snapshot.`,
    };
  }
  const stored = storeAriOccupancy(bookings, rooms, { from, to });
  const occ = occupancyByMonth();
  return {
    ok: true,
    from,
    to,
    bookings: stored.bookings,
    rooms: stored.rooms,
    thisMonth: occ.thisMonth,
    occupancy: occ.current.occupancy,
    bookedNights: occ.current.bookedNights,
    errors,
  };
}

/** Room types from a Room Status response (<RoomsTypes><RoomType Code Description/>). */
export function parseStatusRoomTypes(xml: string): RoomTypeInfo[] {
  const x = decodeEntities(xml);
  const scope = x.match(/<RoomsTypes\b[^>]*>([\s\S]*?)<\/RoomsTypes>/i)?.[1] ?? x;
  const out: RoomTypeInfo[] = [];
  const seen = new Set<string>();
  const re = /<RoomType\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    const code = (attr(m[1], "Code") ?? attr(m[1], "id") ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const desc = (attr(m[1], "Description") ?? attr(m[1], "RoomName") ?? "").trim();
    out.push({ code, description: desc || code });
  }
  return out;
}

/** Try every room-type response shape (getRoomTypes / room-status / ARI rate feed). */
function anyRoomTypes(text: string): RoomTypeInfo[] {
  const a = parseRoomTypes(text);
  if (a.length) return a;
  const b = parseStatusRoomTypes(text);
  if (b.length) return b;
  return parseAriRoomTypes(text);
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
  const errorSet = new Set<string>();
  let types: RoomTypeInfo[] = [];
  let snippet = "";

  if (opts.xml) {
    snippet = snip(opts.xml);
    extractMiniHotelErrors(opts.xml).forEach((e) => errorSet.add(e));
    types = anyRoomTypes(opts.xml);
  } else {
    // Try each source until one yields room types. Accounts differ in which APIs
    // they expose, and the Bulk ARI feed can be blocked entirely by a single
    // misconfigured room type (ERR 310) — so fall through:
    //   1) getRoomTypes  (Content & Data API — richest, needs Content access)
    //   2) Room Status   (ARI — lists every room/type, ignores occupancy/price)
    //   3) Bulk ARI feed (ARI — room types embedded in the rate response)
    const sources: { label: string; run: () => Promise<string> }[] = [
      { label: "getRoomTypes", run: () => fetchRoomTypes(conn) },
      { label: "roomStatus", run: () => fetchRoomStatus(conn) },
      { label: "bulkAri", run: () => fetchBulkAri(conn, todayLocal(), plusDays(todayLocal(), 1)) },
    ];
    for (const src of sources) {
      try {
        const text = await src.run();
        const found = anyRoomTypes(text);
        if (found.length > 0) {
          types = found;
          errorSet.clear(); // a source succeeded; earlier errors are moot
          break;
        }
        snippet = snip(text);
        extractMiniHotelErrors(text).forEach((e) => errorSet.add(e));
      } catch (e) {
        errorSet.add(e instanceof Error ? e.message : `${src.label} failed`);
      }
    }
  }
  const errors = [...errorSet];

  // Drop apartments the operator has deleted/excluded so they don't reappear.
  const excluded = getExcludedRoomCodes();
  if (excluded.size > 0) types = types.filter((t) => !excluded.has(t.code.trim().toUpperCase()));

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
  vatFlag?: string; // MiniHotel's Vat flag ("Yes" incl / "Not" excl), when present
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

/**
 * Fallback id for rows the PMS sent without one: derived from the row's content,
 * not its position in the response — positional ids change whenever the query
 * window shifts, which turns re-syncs of the same booking into duplicate revenue
 * rows. An occurrence counter keeps genuinely identical rows distinct (and is
 * stable, since identical rows are interchangeable).
 */
function syntheticId(
  seen: Map<string, number>,
  parts: Array<string | number | null | undefined>,
): string {
  const base = parts.map((p) => (p == null ? "" : String(p))).join("_");
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
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
  const seen = new Map<string, number>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const checkIn = normDate(pickCI(o, RF.checkIn) as string);
    const checkOut = normDate(pickCI(o, RF.checkOut) as string);
    const gross = normNum(pickCI(o, RF.gross) as string | number);
    if (!checkIn || !checkOut || gross == null) continue;
    const id = pickCI(o, RF.id);
    const roomNumber = (pickCI(o, RF.roomNumber) as string) || undefined;
    out.push({
      id: id != null ? String(id) : syntheticId(seen, [checkIn, checkOut, roomNumber, gross]),
      checkIn,
      checkOut,
      gross,
      roomType: (pickCI(o, RF.roomType) as string) || undefined,
      roomNumber,
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
  const seen = new Map<string, number>();
  // A <Total> amount that is present but EMPTY (group bookings ship
  // <Total AmountAfterTaxes="" …/> at booking level, §2.5) must read as "no
  // amount", not 0 — Number("") is 0, which would book the whole stay as ₪0.
  const amountOf = (totalAttrs: string): number | null => {
    if (!totalAttrs) return null;
    const after = attr(totalAttrs, "AmountAfterTaxes");
    const v = after != null && after.trim() !== "" ? after : attr(totalAttrs, "value");
    return v != null && v.trim() !== "" ? normNum(v) : null;
  };
  const re = /<Booking\b([^>]*)>([\s\S]*?)<\/Booking>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const head = m[1];
    const inner = m[2];
    const ts = firstBlock(/<Timespan\b([^>]*?)\/?>/i, inner) || firstBlock(/<StayDate\b([^>]*?)\/?>/i, inner);
    const checkIn = normDate(attr(ts, "arrival"));
    const checkOut = normDate(attr(ts, "departure"));
    // Whole-stay total: the booking-level <ResGlobalInfo> total when it carries
    // an amount; otherwise the SUM of the per-<RoomStay> totals (multi-room
    // group bookings put the money on each room and leave the global total
    // empty — taking just the first <Total> would drop the other rooms' revenue).
    const globalScope = firstBlock(/<ResGlobalInfo\b[^>]*>([\s\S]*?)<\/ResGlobalInfo>/i, inner);
    const globalTotal = globalScope ? firstBlock(/<Total\b([^>]*?)\/?>/i, globalScope) : "";
    let gross = amountOf(globalTotal);
    let totalAttrs = globalTotal;
    if (gross == null) {
      let sum = 0;
      let found = false;
      const rsRe = /<RoomStay\b[^>]*?(?:\/>|>([\s\S]*?)<\/RoomStay>)/gi;
      let rs: RegExpExecArray | null;
      while ((rs = rsRe.exec(inner))) {
        const t = firstBlock(/<Total\b([^>]*?)\/?>/i, rs[1] ?? "");
        const v = amountOf(t);
        if (v != null) {
          sum += v;
          if (!found) totalAttrs = t;
          found = true;
        }
      }
      if (found) gross = sum;
    }
    if (gross == null) {
      // Last resort (non-standard shapes): the first <Total> anywhere.
      const t = firstBlock(/<Total\b([^>]*?)\/?>/i, inner);
      gross = amountOf(t);
      totalAttrs = t;
    }
    if (!checkIn || !checkOut || gross == null) continue;
    const stay = firstBlock(/<RoomStay\b([^>]*?)\/?>/i, inner);
    const country = firstBlock(/<Country\b([^>]*?)\/?>/i, inner);
    const roomNumber = attr(stay, "roomNumber") || undefined;
    out.push({
      id:
        attr(head, "Minihotel_reservation_id") ||
        attr(head, "Portal_reservation_id") ||
        syntheticId(seen, [checkIn, checkOut, roomNumber, gross]),
      checkIn,
      checkOut,
      gross,
      roomType: attr(stay, "roomTypeId") || attr(stay, "roomTypeID") || undefined,
      roomNumber,
      country: attr(country, "iso2") || attr(country, "iso3") || attr(country, "CountryName") || undefined,
      vatFlag: attr(country, "Vat") || attr(head, "Vat") || undefined,
      currency: attr(totalAttrs, "CurrencyCode") || attr(globalTotal, "CurrencyCode") || undefined,
      status: attr(head, "Status") || undefined,
    });
  }
  return out;
}

/** Generic <Reservation>/<Booking>/<Res> fallback for non-standard XML shapes. */
function parseReservationsXml(xml: string): MiniReservation[] {
  const out: MiniReservation[] = [];
  const seen = new Map<string, number>();
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
      id:
        xmlField(block, RF.id) ||
        syntheticId(seen, [checkIn, checkOut, xmlField(block, RF.roomNumber), gross]),
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
  const a = miniHotelContentAuth(conn);
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    "<GetReservationKey>" +
    `<Authentication username="${escXml(a.username)}" password="${escXml(a.password)}" />` +
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
    // Treat an embedded ERR code as fatal only when the response carries no
    // bookings — reservation payloads are full of free text (guest names,
    // remarks) that a bare substring match would misread as an error and
    // abort an otherwise-successful pull.
    const decoded = decodeEntities(text);
    if (!/<Booking\b/i.test(decoded)) {
      const err = decoded.match(/\bERR\s?\d+[^<\n]*/);
      if (err) throw new Error(`MiniHotel ${err[0].trim()}`);
    }
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
  /** Stored rows flipped to cancelled by the cancellation sweep (live pulls only). */
  cancelledSwept?: number;
  /** The sweep is best-effort — its failure is reported here, never thrown. */
  sweepError?: string;
  message?: string;
}

/** GetReservationKey with Cancellations="YES" — CreateDate is then the CANCELLATION
 *  action date (§3.3), so this returns "everything cancelled between from and to". */
export function buildCancellationsRequest(conn: MiniHotelConnection, from: string, to: string): string {
  const a = miniHotelContentAuth(conn);
  return (
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    "<GetReservationKey>" +
    `<Authentication username="${escXml(a.username)}" password="${escXml(a.password)}" />` +
    `<Hotel id="${escXml(conn.hotelId)}" />` +
    `<CreateDate From="${from}" To="${to}" />` +
    "<Cancellations>YES</Cancellations>" +
    "</GetReservationKey>"
  );
}

export async function fetchCancellations(conn: MiniHotelConnection, from: string, to: string): Promise<string> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${ep.content}/api/Agents/Sci/Reservation/GetReservationKey`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildCancellationsRequest(conn, from, to),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MiniHotel HTTP ${res.status}: ${text.slice(0, 160)}`);
    // Zero cancellations is a normal (booking-less) response; only a bare error
    // body is a failure.
    const decoded = decodeEntities(text);
    if (!/<Booking\b/i.test(decoded)) {
      const err = decoded.match(/\bERR\s?\d+[^<\n]*/);
      if (err) throw new Error(`MiniHotel ${err[0].trim()}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lenient id/status extraction for the cancellation feed. Deliberately NOT the
 * full reservation parser: cancelled entries may ship without totals, and the
 * full parser drops price-less rows — but for a cancellation only the identity
 * matters. These ids are applied as status UPDATES to already-stored rows.
 */
export function parseCancelledIds(xml: string): Array<{ id: string; status: string }> {
  const x = decodeEntities(xml);
  const out: Array<{ id: string; status: string }> = [];
  const seen = new Set<string>();
  const re = /<Booking\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const head = m[1];
    const id = attr(head, "Minihotel_reservation_id") || attr(head, "Portal_reservation_id") || attr(head, "id");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Whatever status the feed carries wins; default "CL" (MiniHotel's cancelled
    // code) — every row in a Cancellations="YES" response is cancelled by definition.
    out.push({ id, status: attr(head, "Status") || "CL" });
  }
  return out;
}

// Money is re-checked, not remembered. Stays run 30-90+ nights, so the bookings
// most likely to change (extensions, shortened stays, compensations, rate edits)
// arrived WEEKS ago — a "today forward" pull would never re-read them, freezing
// whatever price was first captured. Every sync therefore re-pulls all arrivals
// from RES_LOOKBACK_DAYS back through RES_HORIZON_DAYS forward and overwrites
// each stored row with MiniHotel's current price/dates/status.
const RES_LOOKBACK_DAYS = 210; // covers the longest in-house stay + late corrections to closed months
const RES_HORIZON_DAYS = 120;

export async function syncReservationsFromMiniHotel(opts: {
  from?: string;
  days?: number;
  payload?: string; // captured response — parse this instead of calling MiniHotel
}): Promise<ReservationSyncResult> {
  const conn = getMiniHotelConnection();
  const from =
    opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)
      ? opts.from
      : plusDays(todayLocal(), -RES_LOOKBACK_DAYS);
  const days = Math.max(1, Math.min(370, opts.days ?? RES_LOOKBACK_DAYS + RES_HORIZON_DAYS));
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
      gross: r.gross, // tax-inclusive — upsertReservations derives net from flag/country
      country: r.country,
      vatFlag: r.vatFlag,
      currency: r.currency,
      status: r.status,
    })),
  );

  // Cancellation sweep: arrival-window pulls may simply omit a booking once it's
  // cancelled, which would leave its revenue counting forever. Ask MiniHotel for
  // cancellation ACTIONS in the window (§3.3 Cancellations="YES") and flip those
  // rows out of revenue. Non-fatal — the main pull already succeeded.
  let cancelledSwept: number | undefined;
  let sweepError: string | undefined;
  if (!opts.payload) {
    try {
      const cxml = await fetchCancellations(conn, from, todayLocal());
      cancelledSwept = markReservationsCancelled(parseCancelledIds(cxml));
    } catch (e) {
      sweepError = e instanceof Error ? e.message : "cancellation sweep failed";
    }
    // Freshness marker for the auto-refresh hook (live checks only — a captured
    // payload refreshes rows but isn't a verification against MiniHotel).
    getDb()
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reservations_synced_at', ?)")
      .run(new Date().toISOString());
  }

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
    cancelledSwept,
    sweepError,
  };
}

// ------------------------------------------------- freshness (auto re-check)
// The P&L must never quietly serve remembered money. Reading a money endpoint
// calls this: if the last live verification against MiniHotel is older than
// RESERVATIONS_MAX_AGE_HOURS (default 6, 0 disables), a background re-sync is
// kicked — the current request still answers instantly from stored data, the
// next one reads the re-checked numbers. Single-flight, and failed attempts
// back off 10 minutes so a dead MiniHotel doesn't get hammered per page view.
let resSyncInFlight: Promise<unknown> | null = null;
let resSyncLastAttempt = 0;

export function ensureFreshReservations(): void {
  const maxAgeHours = Number(process.env.RESERVATIONS_MAX_AGE_HOURS ?? 6);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return;
  const row = getDb()
    .prepare("SELECT value FROM meta WHERE key = 'reservations_synced_at'")
    .get() as { value: string } | undefined;
  const last = row ? Date.parse(row.value) : NaN;
  if (Number.isFinite(last) && Date.now() - last < maxAgeHours * 3_600_000) return;
  if (resSyncInFlight || Date.now() - resSyncLastAttempt < 10 * 60_000) return;
  resSyncLastAttempt = Date.now();
  resSyncInFlight = syncReservationsFromMiniHotel({})
    .catch(() => undefined) // unreachable PMS → stored data keeps serving
    .finally(() => {
      resSyncInFlight = null;
    });
}
