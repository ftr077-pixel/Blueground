import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { rebaseFuturePrices } from "@/lib/repos/rates";
import { getMiniHotelConnection } from "@/lib/repos/integrations";
import { pushRatesToMiniHotel, type PushResult } from "@/lib/integrations/minihotel";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

// Push the Hub's intended prices OUT to MiniHotel (Reverse ARI) for every
// apartment over the coming horizon. "Intended" = the operator's manual pins
// where set, otherwise the price derived from the unit's Base (clamped by any
// per-date min/max). Sold/closed nights and units without a Base are skipped;
// superseded MiniHotel-synced prices are cleared locally so the calendar shows
// exactly what was sent. The mirror of "Pull from MiniHotel" (/api/rates/sync).
export async function POST(req: Request) {
  let body: { days?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  const days = Math.max(7, Math.min(120, Math.round(Number(body.days)) || 90));

  // Check the connection BEFORE rebasing anything — if we can't push at all,
  // don't touch the locally staged calendar.
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return NextResponse.json({
      ok: false,
      message: "MiniHotel connection isn't configured (Settings).",
    });
  }
  if (!conn.rateCode || conn.rateCode.trim() === "") {
    return NextResponse.json({
      ok: false,
      message:
        "No price-list (rate) code set — Settings → Find rate code. MiniHotel needs the exact code to write a price.",
    });
  }

  const units = listUnits();
  const CHUNK = 12; // keep each Reverse-ARI request a sane size
  let repriced = 0;
  let pushed = 0;
  let unitsPushed = 0;
  let unmappedUnits = 0;
  const warnings: string[] = [];
  const errors: string[] = [];
  let verified: PushResult["verified"]; // first chunk we could actually read back

  for (let i = 0; i < units.length; i += CHUNK) {
    const chunk = units.slice(i, i + CHUNK);
    const items: { unitId: string; date: string; price: number; minNights: number }[] = [];
    for (const u of chunk) {
      const nights = rebaseFuturePrices(u.id, days);
      if (nights.length) unitsPushed++;
      repriced += nights.length;
      for (const n of nights) items.push({ unitId: u.id, date: n.date, price: n.price, minNights: n.minStay });
    }
    if (items.length === 0) continue;
    const res = await pushRatesToMiniHotel(items);
    pushed += res.pushed;
    unmappedUnits += res.unmappedUnits;
    warnings.push(...res.warnings);
    errors.push(...res.errors);
    if (!verified && res.verified && res.verified.checked > 0) verified = res.verified;
    if (!res.ok && res.message && res.roomTypes === 0 && res.unmappedUnits === 0) {
      // Configuration-level failure — surface and stop.
      errors.push(res.message);
      break;
    }
  }

  const ok = errors.length === 0 && pushed > 0;
  const message =
    pushed === 0 && errors.length === 0
      ? unmappedUnits > 0
        ? `Nothing pushed — ${unmappedUnits} apartment(s) aren't mapped to MiniHotel room types (Settings → apartment mapping).`
        : "Nothing to push — no apartments with a Base price and open future nights."
      : undefined;
  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `Rates Calendar · push to MiniHotel: ${pushed}/${repriced} night(s) across ${unitsPushed} apartment(s), ${days}-day horizon${
      unmappedUnits ? ` — ${unmappedUnits} apartment(s) unmapped` : ""
    }${errors.length ? ` — ${errors.length} error(s): ${errors.slice(0, 2).join(" | ")}` : ""}.`,
    level: ok ? "success" : "warning",
  });

  return NextResponse.json({
    ok,
    repriced,
    pushed,
    units: unitsPushed,
    unmappedUnits,
    days,
    warnings: warnings.slice(0, 5),
    errors: errors.slice(0, 5),
    verified,
    message,
  });
}
