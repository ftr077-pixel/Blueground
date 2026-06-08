import { NextResponse } from "next/server";
import { recordRun, type RecordRunInput } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Ingest results from the scraper box. Protected by a shared key when
// SCRAPER_API_KEY is set (required in production; open in local dev).
export async function POST(req: Request) {
  const required = process.env.SCRAPER_API_KEY;
  if (required) {
    if (req.headers.get("x-scraper-key") !== required) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    console.warn(
      "[visibility] SCRAPER_API_KEY not set — accepting snapshot without auth (dev only)",
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const input = (body ?? {}) as Partial<RecordRunInput>;
  if (!input.profileId || !input.runId || !Array.isArray(input.snapshots)) {
    return NextResponse.json(
      { error: "missing profileId, runId, or snapshots[]" },
      { status: 400 },
    );
  }

  const recorded = recordRun({
    profileId: input.profileId,
    runId: input.runId,
    snapshots: input.snapshots,
    listingMinNights: input.listingMinNights,
    searchResults: input.searchResults,
  });
  return NextResponse.json({ ok: true, recorded });
}
