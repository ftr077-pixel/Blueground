import { NextResponse } from "next/server";
import { buildPacingReport } from "@/lib/pacing";
import { ensureFreshReservations } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// The Pacing tab's single read: stay-date pacing buckets (market vs us, this
// year vs last) plus booking curves. All inputs are optional — the builder
// falls back to a past-6/future-6-months monthly window and the first synced
// market dashboard / search profile.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  try {
    // The booking curves read reservation data — kick a background re-sync if it's
    // stale (whitelisted box only; no-ops where MiniHotel is unreachable). This is
    // what backfills the real created_on dates with no manual step.
    ensureFreshReservations();
    const report = buildPacingReport({
      from: p.get("from"),
      to: p.get("to"),
      agg: p.get("agg"),
      dashboard: p.get("dashboard"),
      compset: p.get("compset"),
    });
    return NextResponse.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build pacing report";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
