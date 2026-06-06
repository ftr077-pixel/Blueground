import { NextResponse } from "next/server";
import { createListing, createListingsBulk, listListings } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

interface ListingBody {
  profileId?: string;
  airbnbId?: string;
  label?: string;
  bulk?: string;
}

export async function GET() {
  return NextResponse.json({ listings: listListings() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ListingBody | null;
  if (!body || !body.profileId) {
    return NextResponse.json({ error: "profileId required" }, { status: 400 });
  }
  if (typeof body.bulk === "string" && body.bulk.trim()) {
    const count = createListingsBulk(body.profileId, body.bulk);
    return NextResponse.json({ created: count }, { status: 201 });
  }
  if (!body.airbnbId || !String(body.airbnbId).trim()) {
    return NextResponse.json({ error: "airbnbId or bulk required" }, { status: 400 });
  }
  const listing = createListing({
    airbnbId: String(body.airbnbId).trim(),
    label: body.label,
    profileId: body.profileId,
  });
  return NextResponse.json(listing, { status: 201 });
}
