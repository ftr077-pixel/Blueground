import { NextResponse } from "next/server";
import { syncAriOccupancy } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Pull the booking snapshot from the ARI server (Room Status Inquiry) and store it
// as occupancy. Uses the rates credentials that already work. Optionally accepts a
// captured `xml` to ingest without calling MiniHotel.
export async function POST(req: Request) {
  let body: { from?: string; days?: number; xml?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  try {
    const result = await syncAriOccupancy({ from: body.from, days: body.days, xml: body.xml });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "sync failed" });
  }
}
