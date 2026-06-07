import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

function num(key: string, def: number) {
  const v = getSetting(key);
  return v != null && v !== "" ? Number(v) : def;
}

export async function GET() {
  return NextResponse.json({
    proxyUrl: getSetting("proxy_url") ?? "",
    availabilityDays: num("availability_days", 90),
    primaryStay: num("primary_stay", 30),
    bgFeePct: num("bg_fee_pct", 6),
    airbnbFeePct: num("airbnb_fee_pct", 0),
    defaultUtilities: num("default_utilities", 1000),
    defaultCleaning: num("default_cleaning", 500),
    weeklyDiscountPct: num("los_weekly_pct", 0),
    biWeeklyDiscountPct: num("los_biweekly_pct", 0),
    monthlyDiscountPct: num("los_monthly_pct", 0),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    proxyUrl?: string;
    availabilityDays?: number;
    primaryStay?: number;
    bgFeePct?: number;
    airbnbFeePct?: number;
    defaultUtilities?: number;
    defaultCleaning?: number;
    weeklyDiscountPct?: number;
    biWeeklyDiscountPct?: number;
    monthlyDiscountPct?: number;
  } | null;
  if (body == null) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  if (body.proxyUrl !== undefined) setSetting("proxy_url", (body.proxyUrl ?? "").trim());
  if (body.availabilityDays !== undefined)
    setSetting("availability_days", String(Math.max(1, Math.round(body.availabilityDays))));
  if (body.primaryStay !== undefined)
    setSetting("primary_stay", String(Math.max(1, Math.round(body.primaryStay))));
  if (body.bgFeePct !== undefined)
    setSetting("bg_fee_pct", String(Math.max(0, Math.min(100, body.bgFeePct))));
  if (body.airbnbFeePct !== undefined)
    setSetting("airbnb_fee_pct", String(Math.max(0, Math.min(100, body.airbnbFeePct))));
  if (body.defaultUtilities !== undefined)
    setSetting("default_utilities", String(Math.max(0, Math.round(body.defaultUtilities))));
  if (body.defaultCleaning !== undefined)
    setSetting("default_cleaning", String(Math.max(0, Math.round(body.defaultCleaning))));
  if (body.weeklyDiscountPct !== undefined)
    setSetting("los_weekly_pct", String(Math.max(0, Math.min(90, body.weeklyDiscountPct))));
  if (body.biWeeklyDiscountPct !== undefined)
    setSetting("los_biweekly_pct", String(Math.max(0, Math.min(90, body.biWeeklyDiscountPct))));
  if (body.monthlyDiscountPct !== undefined)
    setSetting("los_monthly_pct", String(Math.max(0, Math.min(90, body.monthlyDiscountPct))));
  return NextResponse.json({ ok: true });
}
