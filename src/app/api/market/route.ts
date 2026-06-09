import { NextResponse } from "next/server";
import { listMarketSnapshots } from "@/lib/repos/market";
import { isAirRoiConfigured } from "@/lib/pricing/airroi-client";
import { syncMarketData } from "@/lib/pricing/airroi-sync";

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

// Manual "Sync now" from the dashboard UI. Behind the dashboard login (the cron
// uses /api/market/sync with the key instead). Returns per-area results so the
// UI can show exactly what synced or why it failed.
export async function POST() {
  const result = await syncMarketData();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

