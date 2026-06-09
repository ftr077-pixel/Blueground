import { NextResponse } from "next/server";
import { listMarketSnapshots } from "@/lib/repos/market";
import { isAirRoiConfigured } from "@/lib/pricing/airroi-client";

export const dynamic = "force-dynamic";

// Full market snapshots (summary + forward pacing + min-nights series) for the
// Market Analytics dashboard. Browser-facing, so it stays behind the dashboard
// login (unlike /api/market/sync, which is the machine-to-machine refresh).
export async function GET() {
  const snapshots = listMarketSnapshots();
  return NextResponse.json({
    source: snapshots.length > 0 ? "airroi" : "none",
    configured: isAirRoiConfigured(),
    snapshots,
  });
}
