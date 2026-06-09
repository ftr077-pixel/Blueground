import { NextResponse } from "next/server";
import { pullAriReservations } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Probe the ARI server (api.minihotel.cloud) for the reservation list via Room
// Status Inquiry — uses the credentials that already work for rates. Preview only:
// this ARI view has no revenue, so it does not write the P&L. Optionally accepts a
// captured `xml` to parse without calling MiniHotel.
export async function POST(req: Request) {
  let body: { from?: string; days?: number; xml?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  try {
    const result = await pullAriReservations({ from: body.from, days: body.days, xml: body.xml });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "probe failed" });
  }
}
