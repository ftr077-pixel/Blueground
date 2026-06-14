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
    pricingRules: {
      marginLow: num("pr_margin_low", 25),
      marginHigh: num("pr_margin_high", 45),
      rankWellPage: num("pr_rank_well_page", 1),
      buriedPage: num("pr_buried_page", 5),
      urgentDays: num("pr_urgent_days", 14),
      relaxedDays: num("pr_relaxed_days", 45),
      stepPct: num("pr_step_pct", 5),
      floorMargin: num("pr_floor_margin", -10),
    },
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
    pricingRules?: {
      marginLow?: number;
      marginHigh?: number;
      rankWellPage?: number;
      buriedPage?: number;
      urgentDays?: number;
      relaxedDays?: number;
      stepPct?: number;
      floorMargin?: number;
    };
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
  const pr = body.pricingRules;
  if (pr) {
    const setNum = (key: string, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) setSetting(key, String(Math.max(0, v)));
    };
    setNum("pr_margin_low", pr.marginLow);
    setNum("pr_margin_high", pr.marginHigh);
    setNum("pr_rank_well_page", pr.rankWellPage);
    setNum("pr_buried_page", pr.buriedPage);
    setNum("pr_urgent_days", pr.urgentDays);
    setNum("pr_relaxed_days", pr.relaxedDays);
    setNum("pr_step_pct", pr.stepPct);
    // Floor margin alone may be negative: a loss-leader floor (−10 ⇒ allow cuts
    // down to a 10% loss to buy a search slot). Bounded to keep the cost math sane
    // (below ~94% the floor-price denominator would go non-positive).
    if (pr.floorMargin !== undefined && Number.isFinite(pr.floorMargin))
      setSetting("pr_floor_margin", String(Math.max(-100, Math.min(90, pr.floorMargin))));
  }
  return NextResponse.json({ ok: true });
}
