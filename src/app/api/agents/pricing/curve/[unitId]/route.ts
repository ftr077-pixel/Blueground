import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { marketProviders } from "@/lib/pricing/providers";
import { quoteCurve } from "@/lib/pricing/engine";
import { effectiveRulesForUnit } from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

// Forward price + min-stay curve for one unit, computed live by the rule engine.
// Uses the same providers as the pricing pass (live AirROI when synced, mock
// otherwise) so the curve agrees with the rates the pass actually applies, with
// the unit's full scope chain (account → group → sub-group → listing) applied.
export async function GET(_req: Request, { params }: { params: { unitId: string } }) {
  const unit = listUnits().find((u) => u.id === params.unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });

  const curve = quoteCurve(unit, marketProviders(), new Date(), 7, effectiveRulesForUnit(unit)).map((q) => ({
    date: q.date,
    leadDays: q.leadDays,
    rate: q.rate,
    rawRate: q.rawRate,
    bound: q.bound,
    minPrice: q.minPrice,
    minPriceSource: q.minPriceSource,
    minStay: q.minStay,
    minStaySource: q.minStaySource,
    effectiveMonthlyRate: q.effectiveMonthlyRate,
    factors: q.factors,
  }));

  return NextResponse.json({
    unit: { id: unit.id, name: unit.name, neighborhood: unit.neighborhood, baseRate: unit.baseRate },
    curve,
  });
}
