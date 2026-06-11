import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { marketProviders } from "@/lib/pricing/providers";
import { quoteNight } from "@/lib/pricing/engine";
import { effectiveRulesForUnit } from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

// "Review Recommended Stay Settings" (Min Stay Recommendation Engine): the
// dynamic recommended minimum stay for each of the next 12 months — sampled
// mid-month through the live engine (so flavor, demand tiers, far-out rule and
// the Adaptive Occupancy reduction all apply). Months deviating from the annual
// mode are flagged as seasonal exceptions, the engine's cue to hang a Min Stay
// Profile on a season. Recommendations are computed at read time, so the
// monthly auto-refresh is inherent.
export async function GET(req: Request) {
  const unitId = new URL(req.url).searchParams.get("unitId") || "";
  const unit = listUnits().find((u) => u.id === unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });

  const cfg = effectiveRulesForUnit(unit);
  const market = marketProviders();
  const asOf = new Date();

  const months: Array<{ month: string; minStay: number; source: string }> = [];
  const cursor = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 15));
  for (let i = 0; i < 12; i++) {
    const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + i, 15));
    if (date.getTime() < asOf.getTime()) date.setUTCDate(28); // keep the first sample in the future
    const q = quoteNight(unit, date, market, asOf, cfg);
    months.push({
      month: date.toISOString().slice(0, 7),
      minStay: q.minStay,
      source: q.minStaySource,
    });
  }

  // Annual mode = the most common recommendation; deviating months are the
  // "exception months" PriceLabs calls out for seasonal profiles.
  const freq = new Map<number, number>();
  for (const m of months) freq.set(m.minStay, (freq.get(m.minStay) ?? 0) + 1);
  const annual = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? unit.lowestMinStay;

  return NextResponse.json({
    unit: { id: unit.id, name: unit.name, neighborhood: unit.neighborhood },
    flavor: cfg.minStayRules.recommendedFlavor,
    mode: cfg.minStayRules.mode,
    lowestAllowed: unit.lowestMinStay,
    highestAllowed: cfg.minStayRules.highestAllowed,
    annualRecommendation: annual,
    months: months.map((m) => ({ ...m, exception: m.minStay !== annual })),
  });
}
