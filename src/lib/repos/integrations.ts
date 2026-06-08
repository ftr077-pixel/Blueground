import { getSetting, setSetting } from "@/lib/repos/visibility";
import { listUnits, setUnitMiniHotelRoomType, deleteUnit } from "@/lib/repos/units";

/**
 * MiniHotel integration settings.
 *
 * Connection auth is just username + password + hotel_id (no tokens), stored in
 * the `meta` KV table. The password is write-only over the API — the masked view
 * (getMiniHotelConnectionView) never returns it. The apartment mapping
 * (Hub unit -> MiniHotel RoomTypeCode) lives on each unit.
 */

export type MiniHotelEnv = "sandbox" | "production";

export interface MiniHotelConnection {
  env: MiniHotelEnv;
  username: string;
  password: string;
  hotelId: string;
  rateCode: string;
}

export interface MiniHotelEndpoints {
  ari: string; // read ARI (Bulk/Immediate) + send reservations
  reverse: string; // push ARI back into MiniHotel
  content: string; // Content & Data API base (bookings, folio, etc.)
}

const K = {
  env: "minihotel_env",
  username: "minihotel_username",
  password: "minihotel_password",
  hotelId: "minihotel_hotel_id",
  rateCode: "minihotel_rate_code",
  vatRate: "minihotel_vat_rate",
  vatCountries: "minihotel_vat_countries",
  excludedRoomTypes: "minihotel_excluded_room_types",
} as const;

const DEFAULT_VAT_RATE = 0.18; // Israeli standard VAT (locals only; tourists are zero-rated)
const DEFAULT_VAT_COUNTRIES = "IL,ISR,ISRAEL";

function parseRate(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_VAT_RATE;
  let n = Number(raw.replace(/[%\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_VAT_RATE;
  if (n > 1) n = n / 100; // "18" / "18%" => 0.18
  return n;
}
const splitCodes = (raw: string | null | undefined): string[] =>
  (raw ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

/** Israeli VAT rate as a fraction (e.g. 0.18). Configurable in Settings. */
export function getVatRate(): number {
  return parseRate(getSetting(K.vatRate));
}
/** Country tokens that mean "local / VAT-liable" (Israeli guests). */
export function getLocalVatCountries(): Set<string> {
  const codes = splitCodes(getSetting(K.vatCountries) ?? DEFAULT_VAT_COUNTRIES);
  return new Set(codes.length ? codes : splitCodes(DEFAULT_VAT_COUNTRIES));
}
/** Room-type codes / room numbers that are test apartments — kept out of the P&L. */
export function getExcludedRoomCodes(): Set<string> {
  return new Set(splitCodes(getSetting(K.excludedRoomTypes)));
}
/** True if a reservation's country (iso2/iso3/name) is VAT-liable (local). */
export function isLocalVatCountry(country: string | null | undefined): boolean {
  if (!country) return false;
  const locals = getLocalVatCountries();
  return splitCodes(country).some((tok) => locals.has(tok));
}

export function miniHotelEndpoints(env: MiniHotelEnv): MiniHotelEndpoints {
  return env === "production"
    ? {
        ari: "https://api.minihotel.cloud/gds",
        reverse: "https://api2.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA",
        content: "https://api2.minihotel.cloud",
      }
    : {
        ari: "https://sandbox.minihotel.cloud/gds",
        reverse: "https://sandbox.minihotel.cloud/AgentsScreenA/api/Agents/ScreenA",
        content: "https://sandbox.minihotel.cloud",
      };
}

/** Full connection incl. password — SERVER ONLY. Never return to the browser. */
export function getMiniHotelConnection(): MiniHotelConnection {
  const env = getSetting(K.env) === "production" ? "production" : "sandbox";
  return {
    env,
    username: getSetting(K.username) ?? "",
    password: getSetting(K.password) ?? "",
    hotelId: getSetting(K.hotelId) ?? "",
    rateCode: getSetting(K.rateCode) ?? "",
  };
}

export interface MiniHotelConnectionPatch {
  env?: MiniHotelEnv;
  username?: string;
  password?: string; // empty/omitted => keep existing
  hotelId?: string;
  rateCode?: string;
  vatRate?: string; // e.g. "18" or "0.18"
  vatCountries?: string; // comma-separated country tokens that pay VAT
  excludedRoomTypes?: string; // comma-separated test room-type codes / room numbers
}

export function saveMiniHotelConnection(p: MiniHotelConnectionPatch): void {
  if (p.env !== undefined) setSetting(K.env, p.env === "production" ? "production" : "sandbox");
  if (p.username !== undefined) setSetting(K.username, p.username.trim());
  if (p.hotelId !== undefined) setSetting(K.hotelId, p.hotelId.trim());
  if (p.rateCode !== undefined) setSetting(K.rateCode, p.rateCode.trim());
  if (p.vatRate !== undefined) setSetting(K.vatRate, p.vatRate.trim());
  if (p.vatCountries !== undefined) setSetting(K.vatCountries, p.vatCountries.trim());
  if (p.excludedRoomTypes !== undefined) setSetting(K.excludedRoomTypes, p.excludedRoomTypes.trim());
  // Only overwrite the password when a non-empty value is supplied.
  if (typeof p.password === "string" && p.password.length > 0) setSetting(K.password, p.password);
}

export interface MiniHotelConnectionView {
  env: MiniHotelEnv;
  username: string;
  hotelId: string;
  rateCode: string;
  hasPassword: boolean;
  vatRate: number; // fraction, e.g. 0.18
  vatCountries: string;
  excludedRoomTypes: string;
  endpoints: MiniHotelEndpoints;
}

/** Masked view for the browser — never includes the password. */
export function getMiniHotelConnectionView(): MiniHotelConnectionView {
  const c = getMiniHotelConnection();
  return {
    env: c.env,
    username: c.username,
    hotelId: c.hotelId,
    rateCode: c.rateCode,
    hasPassword: c.password.length > 0,
    vatRate: getVatRate(),
    vatCountries: getSetting(K.vatCountries) ?? DEFAULT_VAT_COUNTRIES,
    excludedRoomTypes: getSetting(K.excludedRoomTypes) ?? "",
    endpoints: miniHotelEndpoints(c.env),
  };
}

// ----------------------------------------------------------------- mapping
export interface MiniHotelMapRow {
  unitId: string;
  name: string;
  neighborhood: string;
  platform: string;
  roomType: string | null;
}

export function getMiniHotelMapping(): MiniHotelMapRow[] {
  return listUnits().map((u) => ({
    unitId: u.id,
    name: u.name,
    neighborhood: u.neighborhood,
    platform: u.platform,
    roomType: u.minihotelRoomType,
  }));
}

export function setMiniHotelMapping(pairs: { unitId: string; roomType: string }[]): number {
  const valid = new Set(listUnits().map((u) => u.id));
  let updated = 0;
  for (const p of pairs) {
    if (!valid.has(p.unitId)) continue;
    const code = (p.roomType ?? "").trim();
    setUnitMiniHotelRoomType(p.unitId, code.length ? code : null);
    updated++;
  }
  return updated;
}

/** Add a room-type code to the excluded set (kept out of import + P&L). */
export function addExcludedRoomCode(code: string): void {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return;
  const cur = splitCodes(getSetting(K.excludedRoomTypes));
  if (!cur.includes(c)) {
    cur.push(c);
    setSetting(K.excludedRoomTypes, cur.join(","));
  }
}

/** Delete a Hub apartment and (by default) remember its code so re-import skips it. */
export function deleteMappedUnit(unitId: string, exclude = true): boolean {
  const row = getMiniHotelMapping().find((r) => r.unitId === unitId);
  const ok = deleteUnit(unitId);
  if (ok && exclude && row?.roomType) addExcludedRoomCode(row.roomType);
  return ok;
}
