import { NextResponse } from "next/server";
import { latestLadder, searchResultsStats } from "@/lib/repos/search-results";

export const dynamic = "force-dynamic";

// M1 verification + M2 building block.
//   GET /api/visibility/ladder
//     → per-run ladder coverage (rows accumulate per scan).
//   GET /api/visibility/ladder?profileId=…&nights=30&checkIn=2026-08-01
//     → the most-recent full price ladder for that exact search.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get("profileId");
  const nights = searchParams.get("nights");
  const checkIn = searchParams.get("checkIn");

  if (profileId && nights && checkIn) {
    const n = Number(nights);
    if (!Number.isFinite(n)) {
      return NextResponse.json({ error: "bad 'nights' (number required)" }, { status: 400 });
    }
    const ladder = latestLadder(profileId, n, checkIn);
    return NextResponse.json({ ladder });
  }
  return NextResponse.json({ runs: searchResultsStats() });
}
