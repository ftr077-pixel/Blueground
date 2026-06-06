import { NextResponse } from "next/server";
import { listTrackedSearches } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Consumed by the scraper box: what to search for, this run.
export async function GET() {
  const searches = listTrackedSearches(true).map((s) => ({
    id: s.id,
    listingId: s.listingId,
    label: s.label,
    platform: s.platform,
    guests: s.guests,
    currency: s.currency,
    box: { swLat: s.swLat, swLng: s.swLng, neLat: s.neLat, neLng: s.neLng, zoom: s.zoom },
    stayNights: s.stayNights,
    startDates: s.startDates,
    minNights: s.minNights,
  }));
  return NextResponse.json({ searches });
}
