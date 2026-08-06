import { NextResponse } from "next/server";
import { fetchRawBooking } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Ground truth for one booking: MiniHotel's own <Booking> XML (decoded) next to
// what our parser makes of it. The window defaults to ±1 day around the stored
// reservation's check-in (the pull filters by arrival); widen with ?from=&to=.
// GET /api/reservations/raw?id=007003576
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const id = p.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  try {
    const out = await fetchRawBooking(id, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
    });
    return NextResponse.json(out);
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to fetch the raw booking";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
