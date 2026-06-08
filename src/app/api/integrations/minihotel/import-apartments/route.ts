import { NextResponse } from "next/server";
import { importApartmentsFromMiniHotel } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Import the hotel's apartments (room types) from MiniHotel as real Hub units,
// auto-mapped to their MiniHotel codes. Operator-triggered; behind the dashboard
// login. `replaceDemo` (default true) removes the demo seed apartments.
// Optionally accepts a captured `xml` body to import without calling MiniHotel.
export async function POST(req: Request) {
  let body: { xml?: string; replaceDemo?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
  try {
    const result = await importApartmentsFromMiniHotel({
      xml: body.xml,
      replaceDemo: body.replaceDemo !== false,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "import failed" });
  }
}
