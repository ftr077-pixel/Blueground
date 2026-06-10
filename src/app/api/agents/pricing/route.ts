import { NextResponse } from "next/server";
import { listUnits, listPricingHistory } from "@/lib/repos/units";
import { marketRateBands, marketMinNightsBenchmark } from "@/lib/repos/visibility";
import { activeRuleSummary } from "@/lib/pricing/engine";
import { effectiveRules, effectiveHumanGatePct } from "@/lib/pricing/rules-config";
import { listMarketSnapshots } from "@/lib/repos/market";
import { isAirRoiConfigured } from "@/lib/pricing/airroi-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshots = listMarketSnapshots();
  return NextResponse.json({
    units: listUnits(),
    history: listPricingHistory(undefined, 30),
    market: {
      bands: marketRateBands(),
      minNights: marketMinNightsBenchmark(),
    },
    rules: activeRuleSummary(effectiveRules(), effectiveHumanGatePct()),
    marketData: {
      // "live" once AirROI snapshots exist; the engine then uses them automatically.
      source: snapshots.length > 0 ? "airroi" : "mock",
      configured: isAirRoiConfigured(),
      snapshots: snapshots.map((s) => ({
        neighborhood: s.neighborhood,
        marketName: s.marketName,
        fetchedAt: s.fetchedAt,
        currency: s.currency,
        occupancy: s.summary?.occupancy ?? null,
        adr: s.summary?.average_daily_rate ?? null,
        revpar: s.summary?.rev_par ?? null,
        minNights: s.summary?.min_nights ?? null,
        pacingDays: s.pacing.length,
      })),
    },
  });
}
