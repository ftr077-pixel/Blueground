import {
  getMiniHotelConnection,
  getMiniHotelMapping,
  miniHotelEndpoints,
  type MiniHotelConnection,
} from "@/lib/repos/integrations";
import { upsertOverride } from "@/lib/repos/rates";
import { upsertImportedUnit, deleteUnitsByIdPrefix } from "@/lib/repos/units";

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
  const rtRe = /<RoomType\b([^>]*)>([\s\S]*?)<\/RoomType>/gi;
  let rt: RegExpExecArray | null;
  while ((rt = rtRe.exec(xml))) {
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
  const out: RoomTypeInfo[] = [];
  const re = /<RoomTypes\b[^>]*>([\s\S]*?)<\/RoomTypes>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const code = (block.match(/<Type>([\s\S]*?)<\/Type>/i)?.[1] ?? "").trim();
    if (!code) continue;
    const desc = (block.match(/<Description>([\s\S]*?)<\/Description>/i)?.[1] ?? "").trim();
    out.push({ code, description: desc || code });
  }
  return out;
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
  let xml = opts.xml;
  if (!xml) {
    if (!conn.username || !conn.password || !conn.hotelId) {
      return {
        ok: false,
        imported: 0,
        removedDemo: 0,
        apartments: [],
        errors: [],
        message: "MiniHotel connection isn't configured — set it in Settings first.",
      };
    }
    xml = await fetchRoomTypes(conn);
  }

  const errors = parseAriErrors(xml);
  const types = parseRoomTypes(xml);
  if (types.length === 0) {
    return {
      ok: false,
      imported: 0,
      removedDemo: 0,
      apartments: [],
      errors,
      message: errors.length
        ? `MiniHotel returned: ${errors.join(" | ")}`
        : "No room types returned by MiniHotel.",
    };
  }

  const apartments = types.map((t) => ({ id: `MH-${t.code}`, name: t.description, code: t.code }));
  for (const a of apartments) {
    upsertImportedUnit({ id: a.id, name: a.name, platform: "MiniHotel", minihotelRoomType: a.code });
  }
  const removedDemo = opts.replaceDemo ? deleteUnitsByIdPrefix("BG-") : 0;

  return { ok: true, imported: apartments.length, removedDemo, apartments, errors };
}
