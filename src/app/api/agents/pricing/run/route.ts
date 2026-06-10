import { NextResponse } from "next/server";
import { runPricingPass } from "@/lib/agents/pricing-specialist";

export const dynamic = "force-dynamic";

export async function POST() {
  let result;
  try {
    result = runPricingPass();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pricing pass failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ranAt: result.ranAt,
    summary: {
      total: result.decisions.length,
      applied: result.applied.length,
      flagged: result.flagged.length,
      noOps: result.noOps.length,
      skipped: result.skipped.length,
      alreadyPending: result.alreadyPending.length,
    },
    decisions: result.decisions.map((d) => ({
      unit: { id: d.unitId, name: d.unitName, neighborhood: d.neighborhood },
      oldRate: d.oldRate,
      newRate: d.newRate,
      deltaPct: Number(d.deltaPct.toFixed(2)),
      status: d.status,
      reason: d.reason,
      bound: d.bound,
      effectiveMonthlyRate: d.effectiveMonthlyRate,
      minStay: d.minStay,
      prevMinStay: d.prevMinStay,
      minStaySource: d.minStaySource,
      leadDays: d.leadDays,
      factors: d.factors,
    })),
  });
}
