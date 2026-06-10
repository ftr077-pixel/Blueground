import { NextResponse } from "next/server";
import { buildAttributionReport } from "@/lib/learning/attribution";

export const dynamic = "force-dynamic";

// GET ?windowDays=21 → the strategy-success report: every attributable booking
// joined to the asking price / position / price action live when it was booked,
// summarized per strategy, plus drop→booking follow-through.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("windowDays");
  const windowDays = raw ? Math.max(1, Math.min(90, Number(raw) || 21)) : 21;
  return NextResponse.json(buildAttributionReport(windowDays));
}
