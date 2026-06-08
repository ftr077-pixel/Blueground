import { NextResponse } from "next/server";
import { syncMarketData } from "@/lib/pricing/airroi-sync";
import { isAirRoiConfigured } from "@/lib/pricing/airroi-client";
import { listMarketSnapshots } from "@/lib/repos/market";

export const dynamic = "force-dynamic";

// Status: whether the provider is configured + what's currently cached.
export async function GET() {
  const snapshots = listMarketSnapshots();
  return NextResponse.json({
    configured: isAirRoiConfigured(),
    count: snapshots.length,
    lastFetched: snapshots.reduce<string | null>(
      (max, s) => (max && max > s.fetchedAt ? max : s.fetchedAt),
      null,
    ),
    neighborhoods: snapshots.map((s) => s.neighborhood),
  });
}

// Trigger a market-data refresh (run daily on the box; safe to call manually).
// AirROI bills per call, so we skip if we synced recently unless ?force=1.
export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const minHours = Number(process.env.MARKET_SYNC_MIN_HOURS || 6);
  const last = listMarketSnapshots().reduce<string | null>(
    (max, s) => (max && max > s.fetchedAt ? max : s.fetchedAt),
    null,
  );
  if (!force && last) {
    const ageHours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (ageHours < minHours) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `synced ${ageHours.toFixed(1)}h ago (< ${minHours}h); pass ?force=1 to override`,
        synced: [],
        failed: [],
      });
    }
  }
  const result = await syncMarketData();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
