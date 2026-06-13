import {
  getMiniHotelConnection,
  miniHotelEndpoints,
  getMiniHotelMapping,
  getExcludedRoomCodes,
} from "@/lib/repos/integrations";
import {
  buildBulkAriRequest,
  parseBulkAri,
  fetchBulkAri,
  extractMiniHotelErrors,
  fetchRoomStatusRange,
  fetchReservations,
} from "@/lib/integrations/minihotel";

/**
 * Discover which rate-code / price-list values MiniHotel actually accepts.
 *
 * MiniHotel has no "list price lists" endpoint, so we probe: call Bulk ARI for a
 * 1-night window with each candidate code and read the response —
 *   - ERR 309 "price list not defined"      → the code does NOT exist
 *   - prices (Mprice=…) come back           → valid, has prices
 *   - any other ERR (e.g. 310 occupancy)    → the code IS defined (it got past
 *                                             price-list validation), just warns
 *
 * "ALL" is special: the READ feed treats it as a wildcard and returns prices,
 * but it is not a real price list — Reverse-ARI price WRITES under it are
 * rejected ("Price list 'ALL' doesn't exists"). It's classified "wildcard" so
 * the operator can't save it as the push target by accident.
 *
 * The custom list name often appears nowhere in our guesses, so before probing
 * we fetch one raw wildcard feed and scan it for price-list-looking attribute
 * names MiniHotel itself mentions — any found are probed in the same run.
 *
 * Runs on the box (ARI works there); probes sequentially to avoid ERR 209.
 */

export type RateCodeStatus = "valid" | "valid-warning" | "wildcard" | "not-defined" | "error";

export interface RateCodeProbe {
  code: string;
  status: RateCodeStatus;
  detail: string;
}

const DEFAULT_CANDIDATES = [
  "USD", "EUR", "ILS", "GBP",
  "Standard", "STD", "BAR", "RACK", "FLEX", "FLEXIBLE",
  "NONREF", "NRF", "RO", "BB", "HB", "FB",
  "MAIN", "BASE", "DEFAULT", "WEB", "DIRECT", "Hotdeal",
];

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const isWildcard = (code: string) => /^\*?all\*?$/i.test(code.trim());

// MiniHotel responses are entity-encoded; decode before scanning attributes.
const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");

async function fetchRawAri(
  conn: ReturnType<typeof getMiniHotelConnection>,
  code: string,
): Promise<string | null> {
  const ep = miniHotelEndpoints(conn.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildBulkAriRequest({ ...conn, rateCode: code }, todayUTC(), plusDays(todayUTC(), 1)),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Price-list names the feed itself mentions (rateCode/PriceList/… attributes). */
export function extractListNames(text: string): string[] {
  const x = decodeEntities(text);
  const out = new Set<string>();
  const re =
    /\b(?:rateCode|RateCode|PriceList|priceList|pricelist|PriceListName|ListName|listName|RateName|RatePlan|ratePlan)\s*=\s*"([^"]{1,40})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const v = m[1].trim();
    if (!v || isWildcard(v)) continue;
    out.add(v);
  }
  return [...out];
}

/**
 * Harvest rate-code / price-list names from the operator's OWN reservations —
 * the ground truth. Each booking is sold under a real price list, so its
 * rateCode is exactly what we must write to. Two sources:
 *   1. Content/Data API bookings (GetReservationKey) — these carry rateCode
 *      ("Standard", a custom list, …) on each <Booking>. The reliable source.
 *   2. ARI Room Status reservations — usually NO rate code (board only), kept as
 *      a fallback + to surface a raw tag so the real field can be eyeballed.
 * Returns the names plus one raw tag (Booking preferred), and never throws.
 */
async function harvestReservationRateCodes(
  conn: ReturnType<typeof getMiniHotelConnection>,
): Promise<{ codes: string[]; sampleTag?: string }> {
  const codes = new Set<string>();
  let sampleTag: string | undefined;

  // 1) Content/Data API bookings — query a window around now (filters by arrival
  //    date) likely to contain real stays.
  try {
    const xml = await fetchReservations(conn, plusDays(todayUTC(), -120), plusDays(todayUTC(), 245));
    for (const c of extractListNames(xml)) codes.add(c);
    const tag = decodeEntities(xml).match(/<Booking\b[^>]*>/i)?.[0];
    if (tag) sampleTag = tag.slice(0, 400);
  } catch {
    /* Content API may be disabled (S009) or unreachable — fall through */
  }

  // 2) ARI Room Status reservations — fallback source + raw sample.
  try {
    const xml = await fetchRoomStatusRange(conn, todayUTC(), plusDays(todayUTC(), 180));
    for (const c of extractListNames(xml)) codes.add(c);
    if (!sampleTag) {
      sampleTag = (decodeEntities(xml).match(/<Reservation\b[^>]*?\/?>/i)?.[0] ?? "").slice(0, 400) || undefined;
    }
  } catch {
    /* ignore */
  }

  return { codes: [...codes], sampleTag };
}

async function probeOne(
  conn: ReturnType<typeof getMiniHotelConnection>,
  code: string,
): Promise<RateCodeProbe> {
  const ep = miniHotelEndpoints(conn.env);
  const body = buildBulkAriRequest({ ...conn, rateCode: code }, todayUTC(), plusDays(todayUTC(), 1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { code, status: "error", detail: `HTTP ${res.status}` };

    const errs = extractMiniHotelErrors(text);
    if (/ERR\s?309/i.test(text) || /price list.*not.*defined/i.test(text)) {
      return { code, status: "not-defined", detail: "price list not defined" };
    }
    if (/Mprice\s*=\s*"/i.test(text)) {
      if (isWildcard(code)) {
        return {
          code,
          status: "wildcard",
          detail: "reads prices, but it's a wildcard — MiniHotel REJECTS price writes under it",
        };
      }
      return {
        code,
        status: "valid",
        detail: errs.length ? `prices ✓ · ${errs.length} room issue(s)` : "prices ✓",
      };
    }
    // No ERR 309 and no prices → recognized, but returned nothing usable.
    if (isWildcard(code)) {
      return { code, status: "wildcard", detail: "wildcard — read-only, can't store prices" };
    }
    return { code, status: "valid-warning", detail: errs[0] ?? "accepted, no prices returned" };
  } catch (e) {
    return { code, status: "error", detail: e instanceof Error ? e.message : "error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface DiscoverResult {
  ok: boolean;
  message?: string;
  results: RateCodeProbe[];
  /** Price-list names the ARI feed mentioned (auto-probed). */
  namesSeen: string[];
  /** Rate codes harvested from the operator's real reservations (auto-probed). */
  fromReservations: string[];
  /** A raw reservation tag — shown when no code was found, to reveal the fields. */
  reservationSample?: string;
}

export async function discoverRateCodes(extra: string[] = []): Promise<DiscoverResult> {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return {
      ok: false,
      message: "Set the MiniHotel connection (username, password, hotel id) first.",
      results: [],
      namesSeen: [],
      fromReservations: [],
    };
  }

  // Two ground-truth sources before guessing conventions:
  //   (a) one raw wildcard ARI read — if the feed names price lists, use them;
  //   (b) the operator's OWN reservations — each carries the rate code it was
  //       booked under, which is exactly the price list to write to.
  let namesSeen: string[] = [];
  const raw = await fetchRawAri(conn, "ALL");
  if (raw) namesSeen = extractListNames(raw);
  const harvest = await harvestReservationRateCodes(conn);

  // Candidates: saved code → operator-pasted → reservation codes → feed names →
  // common conventions → "ALL" (shown as wildcard). Deduped, capped.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw2 of [
    conn.rateCode,
    ...extra,
    ...harvest.codes,
    ...namesSeen,
    ...DEFAULT_CANDIDATES,
    "ALL",
  ]) {
    const v = (raw2 ?? "").trim();
    if (!v) continue;
    const k = v.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(v);
    if (candidates.length >= 40) break;
  }

  const results: RateCodeProbe[] = [];
  for (const code of candidates) {
    results.push(await probeOne(conn, code)); // sequential — avoid ERR 209 rate-limit
  }

  const order: Record<RateCodeStatus, number> = {
    valid: 0,
    "valid-warning": 1,
    wildcard: 2,
    "not-defined": 3,
    error: 4,
  };
  results.sort((a, b) => order[a.status] - order[b.status]);
  return {
    ok: true,
    results,
    namesSeen,
    fromReservations: harvest.codes,
    // Only worth showing the raw tag when nothing usable turned up.
    reservationSample: harvest.codes.length === 0 ? harvest.sampleTag : undefined,
  };
}

// ----------------------------------------------------- write-validity test
//
// The read-probe above (Bulk ARI) tests the PORTAL read code space, which only
// answers to the *ALL wildcard — so it falsely reports real WRITE price lists
// (e.g. "STD") as "not defined". The only true test of a write code is an actual
// Reverse-ARI write. This does a near-no-op: it reads one mapped room's CURRENT
// price for a near date and writes that SAME number back under each candidate
// price list, then checks whether MiniHotel rejected it with "price list
// doesn't exist". A valid code → the price is unchanged; an invalid code → the
// write is rejected and nothing changes.

export interface WriteProbe {
  code: string;
  writeValid: boolean;
  detail: string;
}

async function probeWriteOne(
  conn: ReturnType<typeof getMiniHotelConnection>,
  url: string,
  code: string,
  roomType: string,
  date: string,
  price: number,
): Promise<WriteProbe> {
  const body = [{ RoomTypeCode: roomType, Dates: [{ Date: date, Rates: [{ PriceList: code, Price: price }] }] }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
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
    const text = await res.text();
    if (!res.ok) return { code, writeValid: false, detail: `HTTP ${res.status}` };
    // Single-code write → any "price list … doesn't exist" is about THIS code.
    if (/price\s*list\s*'[^']*'\s*doesn'?t\s*exists?/i.test(text)) {
      return { code, writeValid: false, detail: "write rejected — price list doesn't exist" };
    }
    let errs = 0;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.Errors)) errs = j.Errors.length;
    } catch {
      /* non-JSON */
    }
    return {
      code,
      writeValid: true,
      detail: errs ? `accepted ✓ — price written (${errs} other error(s))` : "accepted ✓ — price written",
    };
  } catch (e) {
    return { code, writeValid: false, detail: e instanceof Error ? e.message : "error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function testWriteCodes(
  candidates: string[] = [],
): Promise<{ ok: boolean; message?: string; testCell?: string; results: WriteProbe[] }> {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return { ok: false, message: "Set the MiniHotel connection (username, password, hotel id) first.", results: [] };
  }

  // Mapped, non-excluded room types — we can only safely test on a real room.
  const excluded = getExcludedRoomCodes();
  const mapped = [
    ...new Set(
      getMiniHotelMapping()
        .filter((m) => m.roomType)
        .map((m) => (m.roomType as string).trim())
        .filter(Boolean),
    ),
  ].filter((c) => !excluded.has(c.toUpperCase()));
  if (mapped.length === 0) {
    return {
      ok: false,
      message: "Map at least one apartment to a MiniHotel room type first (Settings → apartment mapping).",
      results: [],
    };
  }
  const mappedSet = new Set(mapped.map((c) => c.toUpperCase()));

  // A real (room, date, price) to write back unchanged — a near-no-op probe.
  let testRoom: string | null = null;
  let testDate = "";
  let testPrice = 0;
  for (const off of [45, 14, 90, 3]) {
    const date = plusDays(todayUTC(), off);
    let xml: string;
    try {
      xml = await fetchBulkAri(conn, date, date);
    } catch {
      continue;
    }
    const hit = parseBulkAri(xml).find(
      (c) => c.price != null && mappedSet.has(c.roomType.trim().toUpperCase()),
    );
    if (hit && hit.price != null) {
      testRoom = hit.roomType;
      testDate = hit.date;
      testPrice = hit.price;
      break;
    }
  }
  if (!testRoom) {
    return {
      ok: false,
      message:
        "Couldn't find a synced price to test against — Pull from MiniHotel first, or set the code in the connection and push one night.",
      results: [],
    };
  }

  // Candidates: saved code, operator-pasted, then STD + ILS + *ALL (the codes
  // the portal-linkage screen exposes — STD description, ILS currency, *ALL
  // wildcard). Deduped, capped.
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of [conn.rateCode, ...candidates, "STD", "ILS", "*ALL"]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const k = v.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(v);
    if (list.length >= 12) break;
  }

  const url = miniHotelEndpoints(conn.env).reverse;
  const results: WriteProbe[] = [];
  for (const code of list) {
    results.push(await probeWriteOne(conn, url, code, testRoom, testDate, testPrice)); // sequential
  }
  results.sort((a, b) => (a.writeValid === b.writeValid ? 0 : a.writeValid ? -1 : 1));
  return { ok: true, testCell: `${testRoom} @ ${testDate} (₪${testPrice})`, results };
}
