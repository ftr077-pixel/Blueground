import { NextResponse } from "next/server";
import { priceBreakdown } from "@/lib/repos/rates";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The full per-night price walk for one (unit, date) — what the Rates Calendar
// hover card shows. Computed on demand (one cell at a time) so the calendar
// payload stays lean. ?unitId=<id>&date=YYYY-MM-DD
export async function GET(req: Request) {
  const url = new URL(req.url);
  const unitId = url.searchParams.get("unitId") || "";
  const date = (url.searchParams.get("date") || "").slice(0, 10);
  if (!unitId) return NextResponse.json({ error: "unitId required" }, { status: 400 });
  if (!DATE_RE.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))) {
    return NextResponse.json({ error: "bad 'date' (YYYY-MM-DD)" }, { status: 400 });
  }
  const breakdown = priceBreakdown(unitId, date);
  if (!breakdown) {
    return NextResponse.json(
      { error: "no breakdown — unit has no Base price or isn't engine-priced for this date" },
      { status: 404 },
    );
  }
  return NextResponse.json(breakdown);
}
