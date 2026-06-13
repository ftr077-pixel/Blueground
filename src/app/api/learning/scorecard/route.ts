import { NextResponse } from "next/server";
import { buildScorecard } from "@/lib/learning/scorecard";

export const dynamic = "force-dynamic";

// GET ?listingId=&windowDays=21&limit=50 → the per-suggestion scorecard: every
// APPLIED learned suggestion (the prediction persisted at apply time) scored
// against what actually happened — did the listing reach the target page within
// the window (hit/miss/pending), and did the mapped unit book in that window.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const listingId = searchParams.get("listingId");
  const wd = Number(searchParams.get("windowDays"));
  const lim = Number(searchParams.get("limit"));
  const windowDays = Number.isFinite(wd) && wd > 0 ? Math.min(90, Math.round(wd)) : 21;
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(200, Math.round(lim)) : 50;
  return NextResponse.json(buildScorecard({ listingId, windowDays, limit }));
}
