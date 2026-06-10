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
 * Runs on the box (ARI works there); probes sequentially to avoid ERR 209.
 */

export type RateCodeStatus = "valid" | "valid-warning" | "not-defined" | "error";

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
      return {
        code,
        status: "valid",
        detail: errs.length ? `prices ✓ · ${errs.length} room issue(s)` : "prices ✓",
      };
    }
    // No ERR 309 and no prices → recognized, but returned nothing usable.
    return { code, status: "valid-warning", detail: errs[0] ?? "accepted, no prices returned" };
  } catch (e) {
    return { code, status: "error", detail: e instanceof Error ? e.message : "error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverRateCodes(
  extra: string[] = [],
): Promise<{ ok: boolean; message?: string; results: RateCodeProbe[] }> {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return { ok: false, message: "Set the MiniHotel connection (username, password, hotel id) first.", results: [] };
  }

  // Candidates: the saved code first, then any the operator pasted, then the
  // common conventions — deduped (case-insensitive), capped, "*ALL" skipped.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [conn.rateCode, ...extra, ...DEFAULT_CANDIDATES]) {
    const v = (raw ?? "").trim();
    if (!v || v === "*ALL") continue;
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
    "not-defined": 2,
    error: 3,
  };
  results.sort((a, b) => order[a.status] - order[b.status]);
  return { ok: true, results };
}
