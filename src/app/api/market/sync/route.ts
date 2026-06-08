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
export async function POST() {
  const result = await syncMarketData();
  const status = result.ok ? 200 : 400;
  return NextResponse.json(result, { status });
}
