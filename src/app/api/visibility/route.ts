import { NextResponse } from "next/server";
import {
  latestRunId,
  listTrackedSearches,
  recentSnapshots,
  snapshotsByRun,
} from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Dashboard data: each tracked search with its latest scan + recent history.
export async function GET() {
  const searches = listTrackedSearches().map((s) => {
    const runId = latestRunId(s.id);
    return {
      ...s,
      latest: runId ? snapshotsByRun(s.id, runId) : [],
      history: recentSnapshots(s.id, 200),
    };
  });
  return NextResponse.json({ searches });
}
