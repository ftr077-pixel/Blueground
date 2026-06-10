import { NextResponse } from "next/server";
import { getListing } from "@/lib/repos/visibility";
import { bookingPace, realizedNightly, recentBookings } from "@/lib/repos/bookings";
import { getMarketPace } from "@/lib/repos/market-pace";

export const dynamic = "force-dynamic";

// GET ?listingId=… (or ?unitId=…) → realized booking outcomes scoped to the
// listing's unit when mapped, else portfolio-wide: realized nightly bands, our
// booking pace, recent bookings, and — when market lead times are on file for the
// listing's area × stay — the market pace and our delta vs it.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const listingId = searchParams.get("listingId");
  const nights = Number(searchParams.get("nights") ?? "30");
  const listing = listingId ? getListing(listingId) : null;

  let unitId = searchParams.get("unitId");
  if (!unitId && listing) unitId = listing.unitId ?? null;

  const pace = bookingPace(unitId);
  const marketPace = listing?.profileId ? getMarketPace(listing.profileId, nights) : null;
  const paceDeltaDays =
    pace.medianLeadDays != null && marketPace?.medianLeadDays != null
      ? pace.medianLeadDays - marketPace.medianLeadDays
      : null;

  return NextResponse.json({
    scope: unitId ? "unit" : "portfolio",
    unitId,
    pace,
    realizedNightly: realizedNightly(unitId),
    recent: recentBookings({ unitId, limit: 12 }),
    marketPace,
    paceDeltaDays,
  });
}
