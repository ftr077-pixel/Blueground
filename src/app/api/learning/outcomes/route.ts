import { NextResponse } from "next/server";
import { getListing } from "@/lib/repos/visibility";
import { bookingPace, realizedNightly, recentBookings } from "@/lib/repos/bookings";

export const dynamic = "force-dynamic";

// GET ?listingId=… (or ?unitId=…) → realized booking outcomes scoped to the
// listing's unit when it's mapped, else portfolio-wide: realized nightly bands,
// our booking pace (lead-time distribution), and recent bookings.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const listingId = searchParams.get("listingId");
  let unitId = searchParams.get("unitId");
  if (!unitId && listingId) unitId = getListing(listingId)?.unitId ?? null;

  return NextResponse.json({
    scope: unitId ? "unit" : "portfolio",
    unitId,
    pace: bookingPace(unitId),
    realizedNightly: realizedNightly(unitId),
    recent: recentBookings({ unitId, limit: 12 }),
  });
}
