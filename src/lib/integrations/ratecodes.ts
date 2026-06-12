import { getMiniHotelConnection, miniHotelEndpoints } from "@/lib/repos/integrations";
import { buildBulkAriRequest, extractMiniHotelErrors } from "@/lib/integrations/minihotel";

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
    /\b(?:rateCode|RateCode|PriceList|priceList|pricelist|PriceListName|ListName|listName|RateName)\s*=\s*"([^"]{1,40})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const v = m[1].trim();
    if (!v || isWildcard(v)) continue;
    out.add(v);
  }
  return [...out];
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

export async function discoverRateCodes(
  extra: string[] = [],
): Promise<{ ok: boolean; message?: string; results: RateCodeProbe[]; namesSeen: string[] }> {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return {
      ok: false,
      message: "Set the MiniHotel connection (username, password, hotel id) first.",
      results: [],
      namesSeen: [],
    };
  }

  // One raw wildcard read first: if the feed itself names price lists, those
  // names join the probe list — a custom list name is usually only
  // discoverable this way.
  let namesSeen: string[] = [];
  const raw = await fetchRawAri(conn, "ALL");
  if (raw) namesSeen = extractListNames(raw);

  // Candidates: the saved code first, then operator-pasted, then names the
  // feed mentioned, then the common conventions — deduped (case-insensitive),
  // capped. "ALL" is probed too so it shows up clearly as a wildcard.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw2 of [conn.rateCode, ...extra, ...namesSeen, ...DEFAULT_CANDIDATES, "ALL"]) {
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
  return { ok: true, results, namesSeen };
}
