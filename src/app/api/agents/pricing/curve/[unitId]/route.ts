import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { marketProviders } from "@/lib/pricing/providers";
import { quoteCurve } from "@/lib/pricing/engine";
import { extraPersonFee, stayNightlyRate } from "@/lib/pricing/rules";
import { effectiveRulesForUnit } from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

// Forward price + min-stay curve for one unit, computed live by the rule engine.
// Uses the same providers as the pricing pass (live AirROI when synced, mock
// otherwise) so the curve agrees with the rates the pass actually applies, with
// the unit's full scope chain (account → group → sub-group → listing) applied.
// ?guests=N adds the Extra Person Fee per night, treating each point as a
// potential check-in day (percent fees price off the check-in day only).
// ?nights=N adds the LOS-adjusted per-night stay rate for that stay length.
export async function GET(req: Request, { params }: { params: { unitId: string } }) {
  const unit = listUnits().find((u) => u.id === params.unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });
  const url = new URL(req.url);
  const guests = Math.max(0, parseInt(url.searchParams.get("guests") || "0", 10) || 0);
  const nights = Math.max(0, parseInt(url.searchParams.get("nights") || "0", 10) || 0);

  const cfg = effectiveRulesForUnit(unit);
  const curve = quoteCurve(unit, marketProviders(), new Date(), 7, cfg).map((q) => ({
    date: q.date,
    leadDays: q.leadDays,
    base: q.base,
    rate: q.rate,
    rawRate: q.rawRate,
    bound: q.bound,
    minPrice: q.minPrice,
    minPriceSource: q.minPriceSource,
    minStay: q.minStay,
    minStaySource: q.minStaySource,
    effectiveMonthlyRate: q.effectiveMonthlyRate,
    checkinAllowed: q.checkinAllowed,
    checkoutAllowed: q.checkoutAllowed,
    pinned: q.pinned,
    extraPersonFee: guests > 0 ? extraPersonFee(q.rate, guests, cfg) : null,
    stayRate: nights > 0 ? stayNightlyRate(q.rate, unit, nights, cfg) : null,
    factors: q.factors,
  }));

  return NextResponse.json({
    unit: { id: unit.id, name: unit.name, neighborhood: unit.neighborhood, baseRate: unit.baseRate },
    curve,
  });
}
