import { NextResponse } from "next/server";
import { apartmentRevenueDetail } from "@/lib/repos/reservations";

export const dynamic = "force-dynamic";

// Drill-down for one apartment's Revenue-by-Apartment figure: every stored
// reservation row behind it (counted and excluded), with the raw money, VAT
// basis, currency, and sync provenance — the debug surface for "this
// apartment's number is wrong".
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const key = p.get("key");
  if (!key) return NextResponse.json({ error: "missing key" }, { status: 400 });
  try {
    return NextResponse.json(apartmentRevenueDetail(key, p.get("from"), p.get("to")));
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build apartment detail";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
