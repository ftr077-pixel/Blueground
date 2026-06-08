import { NextResponse } from "next/server";
import { syncReservationsFromMiniHotel } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Pull actual reservations (real room revenue) from MiniHotel into the Hub, where
// they become the rental-revenue actuals in the P&L. Operator-triggered (uses the
// stored connection); optionally accepts a captured `payload` (JSON or XML) to
// ingest without calling MiniHotel — handy for calibrating against a real response.
export async function POST(req: Request) {
  let body: { from?: string; days?: number; payload?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body is fine — fall back to defaults
  }

  try {
    const result = await syncReservationsFromMiniHotel({
      from: body.from,
      days: body.days,
      payload: body.payload,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "sync failed" });
  }
}
