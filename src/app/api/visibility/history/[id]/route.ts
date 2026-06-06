import { NextResponse } from "next/server";
import { getListing, listingHistory } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const listing = getListing(params.id);
  if (!listing) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    listing: { id: listing.id, label: listing.label, airbnbId: listing.airbnbId },
    history: listingHistory(params.id),
  });
}
