import { NextResponse } from "next/server";
import { syncBookingsFromMiniHotel } from "@/lib/integrations/minihotel-bookings";
import { recentBookings } from "@/lib/repos/bookings";

export const dynamic = "force-dynamic";

// GET  → recently synced bookings.
// POST { from?, to?, days?, xml? } → pull reservations from MiniHotel and store
// them as realized outcomes. Runs from the box (whitelisted IP); this hosted
// environment can't reach MiniHotel, so it returns a clear message instead.
export async function GET() {
  return NextResponse.json({ recent: recentBookings({ limit: 50 }) });
}

export async function POST(req: Request) {
  let body: { from?: string; to?: string; days?: number; xml?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults to the last 30 days
  }
  try {
    const result = await syncBookingsFromMiniHotel(body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      message: `Could not reach MiniHotel from this server (${msg}). This works from your box once its IP is whitelisted.`,
    });
  }
}
