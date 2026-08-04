import { NextResponse } from "next/server";
import { revenueByApartment } from "@/lib/repos/reservations";
import { ensureFreshReservations } from "@/lib/integrations/minihotel";
import { CURRENCY } from "@/lib/repos/rates";

export const dynamic = "force-dynamic";

// Per-apartment NET revenue over an optional stay-date window — the
// reconciliation list for tying the pacing/P&L numbers back to MiniHotel.
// Cancelled/test exclusions are reported with their money, never silently.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  try {
    ensureFreshReservations();
    const report = revenueByApartment(p.get("from"), p.get("to"));
    return NextResponse.json({ ...report, currency: CURRENCY });
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build apartment revenue report";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
