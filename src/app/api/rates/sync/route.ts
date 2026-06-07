import { NextResponse } from "next/server";
import { syncFromMiniHotel } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Pull live ARI from MiniHotel into the Rates Calendar. Operator-triggered
// (uses the stored connection); behind the dashboard login. Optionally accepts
// a captured `xml` body to ingest without calling MiniHotel.
export async function POST(req: Request) {
  let body: { from?: string; days?: number; xml?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body is fine — fall back to defaults
  }

  try {
    const result = await syncFromMiniHotel({ from: body.from, days: body.days, xml: body.xml });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "sync failed" });
  }
}
