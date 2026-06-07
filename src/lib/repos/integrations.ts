import { getSetting, setSetting } from "@/lib/repos/visibility";
import { listUnits, setUnitMiniHotelRoomType } from "@/lib/repos/units";

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
} as const;

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
}

export function saveMiniHotelConnection(p: MiniHotelConnectionPatch): void {
  if (p.env !== undefined) setSetting(K.env, p.env === "production" ? "production" : "sandbox");
  if (p.username !== undefined) setSetting(K.username, p.username.trim());
  if (p.hotelId !== undefined) setSetting(K.hotelId, p.hotelId.trim());
  if (p.rateCode !== undefined) setSetting(K.rateCode, p.rateCode.trim());
  // Only overwrite the password when a non-empty value is supplied.
  if (typeof p.password === "string" && p.password.length > 0) setSetting(K.password, p.password);
}

export interface MiniHotelConnectionView {
  env: MiniHotelEnv;
  username: string;
  hotelId: string;
  rateCode: string;
  hasPassword: boolean;
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
