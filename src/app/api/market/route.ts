import { NextResponse } from "next/server";
import { listMarketSnapshots, activeMarketSource } from "@/lib/repos/market";
import { getSetting, setSetting } from "@/lib/repos/visibility";
import { isAirRoiConfigured } from "@/lib/pricing/airroi-client";
import { syncMarketData } from "@/lib/pricing/airroi-sync";
import { ourMarketSeries } from "@/lib/pricing/our-series";

export const dynamic = "force-dynamic";

// Full market snapshots (summary + historical metrics + forward pacing +
// min-nights) for the Market Analytics dashboard, plus the active comp filter.
// Browser-facing, so it stays behind the dashboard login (unlike
// /api/market/sync, the machine-to-machine refresh).
export async function GET() {
  const snapshots = listMarketSnapshots();
  return NextResponse.json({
    source: snapshots.length > 0 ? activeMarketSource() : "none",
    configured: isAirRoiConfigured(),
    bedrooms: getSetting("market_bedrooms") ?? "",
    snapshots,
    ours: ourMarketSeries(),
  });
}

// Manual "Sync now" from the dashboard UI. An optional { bedrooms } body sets the
// comp filter (persisted for the daily cron too) before syncing. Returns per-area
// results so the UI can show what synced or why it failed.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { bedrooms?: string | number | null };
  if (body && Object.prototype.hasOwnProperty.call(body, "bedrooms")) {
    const v = body.bedrooms;
    setSetting("market_bedrooms", v === null || v === undefined || v === "" ? "" : String(v));
  }
  const result = await syncMarketData();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
