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
  if (!input.searchId || !input.runId || !Array.isArray(input.snapshots)) {
    return NextResponse.json(
      { error: "missing searchId, runId, or snapshots[]" },
      { status: 400 },
    );
  }

  const recorded = recordRun({
    searchId: input.searchId,
    runId: input.runId,
    listingId: input.listingId,
    minNights: input.minNights ?? null,
    snapshots: input.snapshots,
  });
  return NextResponse.json({ ok: true, recorded });
}
