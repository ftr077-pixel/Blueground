import { NextResponse } from "next/server";
import { listMarketPace, setMarketPace } from "@/lib/repos/market-pace";

export const dynamic = "force-dynamic";

// GET  → the market booking-pace rows on file.
// POST { rows: [{ profileId, nights, medianLeadDays?, leadCdf? }] } → upsert the
// market's booking lead-time distribution per area × stay length. This is the
// feed to paste in when you have market booking lead times; the Outcomes card
// then shows "pace vs market".
export async function GET() {
  return NextResponse.json({ rows: listMarketPace() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { rows?: unknown })?.rows)
      ? (body as { rows: unknown[] }).rows
      : null;
  if (!rows) {
    return NextResponse.json({ error: "expected { rows: [{ profileId, nights, medianLeadDays }] }" }, { status: 400 });
  }
  const written = setMarketPace(rows as Parameters<typeof setMarketPace>[0]);
  return NextResponse.json({ ok: true, written });
}
