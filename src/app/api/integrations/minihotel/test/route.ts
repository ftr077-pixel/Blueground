import { NextResponse } from "next/server";
import { getMiniHotelConnection, miniHotelEndpoints } from "@/lib/repos/integrations";
import {
  buildBulkAriRequest,
  buildRoomTypesRequest,
  parseRoomTypes,
  extractMiniHotelErrors,
} from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Auth/permission failures, vs. downstream config validations that only happen
// after a successful login (price list, occupancy, …). Includes the Content API
// credential codes (S004/S008/S009).
const AUTH_FAIL = /ERR\s?(210|109)\b|S00[489]|wrong user|not linked|invalid agent|invalid credentials|permission/i;

interface ProbeResult {
  ok: boolean;
  detail: string;
}

async function call(url: string, body: string): Promise<{ status: number; text: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Probes BOTH MiniHotel APIs separately so Settings can show, at a glance,
// which features are unlocked: ARI (rates) vs Content & Data (bookings/rooms).
export async function POST() {
  const c = getMiniHotelConnection();
  if (!c.username || !c.password || !c.hotelId) {
    return NextResponse.json({
      ok: false,
      message: "Set username, password and hotel id first, then save.",
      ari: { ok: false, detail: "not configured" },
      content: { ok: false, detail: "not configured" },
    });
  }
  const ep = miniHotelEndpoints(c.env);

  // --- ARI API (rates, availability, price push) ---
  let ari: ProbeResult;
  const a = await call(ep.ari, buildBulkAriRequest(c, todayUTC(), plusDays(todayUTC(), 1)));
  if ("error" in a) ari = { ok: false, detail: `unreachable (${a.error})` };
  else if (a.status !== 200) ari = { ok: false, detail: `HTTP ${a.status}` };
  else {
    const errs = extractMiniHotelErrors(a.text);
    const hasData = /AvailRaters|RoomType|AvailRateRs/i.test(a.text);
    if (!hasData && AUTH_FAIL.test(a.text)) ari = { ok: false, detail: errs[0] ?? "credentials rejected" };
    else ari = { ok: true, detail: errs.length ? `config issues: ${errs.slice(0, 2).join(" | ")}` : "responding" };
  }

  // --- Content & Data API (bookings, room types, folio) ---
  let content: ProbeResult;
  const ct = await call(
    `${ep.content}/agents/ws/settings/rooms/RoomsMain.asmx/getRoomTypes`,
    buildRoomTypesRequest(c),
  );
  if ("error" in ct) content = { ok: false, detail: `unreachable (${ct.error})` };
  else if (ct.status !== 200) content = { ok: false, detail: `HTTP ${ct.status}` };
  else {
    const types = parseRoomTypes(ct.text);
    if (types.length > 0) content = { ok: true, detail: `${types.length} room type(s)` };
    else {
      const errs = extractMiniHotelErrors(ct.text);
      content = { ok: false, detail: errs[0] ?? "no room types / not enabled for this account" };
    }
  }

  return NextResponse.json({
    ok: ari.ok,
    message: `${c.env}: ARI ${ari.ok ? "✓" : "✗"} · Content API ${content.ok ? "✓" : "✗"}`,
    ari,
    content,
  });
}
