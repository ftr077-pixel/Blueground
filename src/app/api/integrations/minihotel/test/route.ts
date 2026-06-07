import { NextResponse } from "next/server";
import { getMiniHotelConnection, miniHotelEndpoints } from "@/lib/repos/integrations";

export const dynamic = "force-dynamic";

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

// Verifies the saved credentials by making a tiny Bulk ARI call to MiniHotel.
// Works from the box (whitelisted IP); this hosted environment can't reach
// external hosts, so it will report a clear network error here.
export async function POST() {
  const c = getMiniHotelConnection();
  if (!c.username || !c.password || !c.hotelId) {
    return NextResponse.json({ ok: false, message: "Set username, password and hotel id first, then save." });
  }

  const ep = miniHotelEndpoints(c.env);
  const from = todayUTC();
  const to = plusDays(from, 1);
  const rateCode = c.rateCode || "USD";
  const xml =
    '<?xml version="1.0" encoding="UTF-8" ?>' +
    '<AvailRaterq xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Authentication username="${escXml(c.username)}" password="${escXml(c.password)}" ResponseType="05" />` +
    `<Hotel id="${escXml(c.hotelId)}" />` +
    `<DateRange from="${from}" to="${to}" />` +
    `<Prices rateCode="${escXml(rateCode)}"></Prices>` +
    "</AvailRaterq>";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(ep.ari, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ ok: false, message: `MiniHotel returned HTTP ${res.status}.`, detail: text.slice(0, 200) });
    }
    const err = text.match(/ERR\s?\d+[^<\n]*/i);
    if (err) {
      return NextResponse.json({ ok: false, message: `MiniHotel rejected the request: ${err[0].trim()}`, detail: text.slice(0, 200) });
    }
    const ok = /AvailRaters|RoomType|AvailRateRs/i.test(text);
    return NextResponse.json({
      ok,
      message: ok
        ? `Connected to ${c.env} — ARI responded for hotel '${c.hotelId}'.`
        : "Reached MiniHotel, but the response was unexpected. Check the rate code and hotel id.",
      endpoint: ep.ari,
      detail: ok ? undefined : text.slice(0, 200),
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
