import { NextResponse } from "next/server";
import { buildPacingReport } from "@/lib/pacing";

export const dynamic = "force-dynamic";

// The Pacing tab's single read: stay-date pacing buckets (market vs us, this
// year vs last) plus booking curves. All inputs are optional — the builder
// falls back to a past-6/future-6-months monthly window and the first synced
// market dashboard / search profile.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  try {
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
