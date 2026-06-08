import { NextResponse } from "next/server";
import { getMiniHotelConnection, miniHotelEndpoints } from "@/lib/repos/integrations";
import { buildBulkAriRequest, parseAriErrors } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Errors that mean auth/permission itself failed — vs. downstream hotel-config
// validations (price list, occupancy, …) which only happen AFTER a successful login.
const AUTH_FAIL = /ERR\s?(210|109)\b|wrong user|not linked|invalid agent|invalid credentials|permission/i;

// Verifies the saved credentials with a tiny Bulk ARI call. Works from the box
// (whitelisted IP); this hosted environment can't reach external hosts.
export async function POST() {
  const c = getMiniHotelConnection();
  if (!c.username || !c.password || !c.hotelId) {
    return NextResponse.json({ ok: false, message: "Set username, password and hotel id first, then save." });
  }

  const ep = miniHotelEndpoints(c.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: buildBulkAriRequest(c, todayUTC(), plusDays(todayUTC(), 1)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ ok: false, message: `MiniHotel returned HTTP ${res.status}.`, detail: text.slice(0, 200) });
    }

    const errors = parseAriErrors(text);
    const hasData = /AvailRaters|RoomType|AvailRateRs/i.test(text);

    // Auth/permission rejected (and no data came back) → not connected.
    if (!hasData && AUTH_FAIL.test(text)) {
      return NextResponse.json({
        ok: false,
        message: `Reached MiniHotel, but it rejected the credentials/permissions: ${errors[0] ?? "auth error"}`,
      });
    }

    // Anything else means login succeeded. Surface config issues as warnings,
    // but report the connection as working (you're past auth + price list).
    if (errors.length) {
      return NextResponse.json({
        ok: true,
        message: `Connected to ${c.env} and authenticated ✓ — MiniHotel flagged ${errors.length} config issue(s) you can fix or skip: ${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? " …" : ""}`,
        endpoint: ep.ari,
        warnings: errors,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `Connected to ${c.env} and authenticated ✓ — ARI responded for hotel '${c.hotelId}'.`,
      endpoint: ep.ari,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      message: `Could not reach MiniHotel from this server (${msg}). This works from your box once its IP is whitelisted; this hosted environment can't reach external hosts.`,
      endpoint: ep.ari,
    });
  } finally {
    clearTimeout(timer);
  }
}
