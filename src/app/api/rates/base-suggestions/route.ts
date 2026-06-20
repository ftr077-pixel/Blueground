import { NextResponse } from "next/server";
import { suggestBaseRates, BASE_METHODS, type BaseMethod } from "@/lib/pricing/base-pricing";
import { getCalendar } from "@/lib/repos/rates";

export const dynamic = "force-dynamic";

const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

// Suggested per-unit BASE rates derived from costs (rent + bills + fees) anchored
// to market ADR. ?margin=<fraction, e.g. 0.25> ?method=marketFloor|costPlus|vacancy|blend
// Apply a suggestion with PATCH /api/rates { unitId, baseRate }.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const marginRaw = Number(url.searchParams.get("margin"));
  const targetMargin = Number.isFinite(marginRaw) ? marginRaw : 0.25;
  const methodRaw = url.searchParams.get("method") || "marketFloor";
  const method: BaseMethod = BASE_METHODS.includes(methodRaw as BaseMethod)
    ? (methodRaw as BaseMethod)
    : "marketFloor";

  // Forward occupancy per unit (next 90 nights) for the vacancy method + display.
  const cal = getCalendar(todayLocal(), 90);
  const occByUnit = new Map<string, number | null>(
    cal.rows.map((r) => [r.unit.id, r.occ90 ?? r.occ60 ?? r.occ30]),
  );

  return NextResponse.json(suggestBaseRates({ targetMargin, method, occByUnit }));
}
