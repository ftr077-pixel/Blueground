import { NextResponse } from "next/server";
import { runPricingPass } from "@/lib/agents/pricing-specialist";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = runPricingPass();
  return NextResponse.json({
    ranAt: result.ranAt,
    summary: {
      total: result.decisions.length,
      applied: result.applied.length,
      flagged: result.flagged.length,
      noOps: result.noOps.length,
    },
    decisions: result.decisions.map((d) => ({
      unit: { id: d.unit.id, name: d.unit.name, neighborhood: d.unit.neighborhood },
      oldRate: d.oldRate,
      newRate: d.newRate,
      deltaPct: Number(d.deltaPct.toFixed(2)),
      status: d.status,
      reason: d.reason,
      bound: d.bound,
      effectiveMonthlyRate: d.effectiveMonthlyRate,
      minStay: d.minStay,
      prevMinStay: d.prevMinStay,
    })),
  });
}
