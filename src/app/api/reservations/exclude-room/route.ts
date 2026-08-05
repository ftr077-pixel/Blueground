import { NextResponse } from "next/server";
import { addExcludedRoomCode, getMiniHotelConnectionView } from "@/lib/repos/integrations";

export const dynamic = "force-dynamic";

// Add a room-type code / room number to the excluded set — the room's
// reservations stay stored but drop out of every statistic (revenue,
// occupancy, pacing, P&L). Same list as Settings → MiniHotel → excluded room
// types, where the exclusion can be reviewed or undone.
export async function POST(req: Request) {
  let body: { code?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* fall through to validation */
  }
  const code = (body.code ?? "").trim();
  if (!code) return NextResponse.json({ error: "missing code" }, { status: 400 });
  addExcludedRoomCode(code);
  return NextResponse.json({ ok: true, excludedRoomTypes: getMiniHotelConnectionView().excludedRoomTypes });
}
