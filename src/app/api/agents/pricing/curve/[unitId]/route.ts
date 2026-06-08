import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { mockProviders } from "@/lib/pricing/providers";
import { quoteCurve } from "@/lib/pricing/engine";

export const dynamic = "force-dynamic";

// Forward price + min-stay curve for one unit, computed live by the rule engine.
export async function GET(_req: Request, { params }: { params: { unitId: string } }) {
  const unit = listUnits().find((u) => u.id === params.unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });

  const curve = quoteCurve(unit, mockProviders()).map((q) => ({
    date: q.date,
    leadDays: q.leadDays,
    rate: q.rate,
    rawRate: q.rawRate,
    bound: q.bound,
    minStay: q.minStay,
    effectiveMonthlyRate: q.effectiveMonthlyRate,
    factors: q.factors,
  }));

  return NextResponse.json({
    unit: { id: unit.id, name: unit.name, neighborhood: unit.neighborhood, baseRate: unit.baseRate },
    curve,
  });
}
