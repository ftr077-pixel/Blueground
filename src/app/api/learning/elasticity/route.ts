import { NextResponse } from "next/server";
import { elasticityForListing } from "@/lib/learning/elasticity";

export const dynamic = "force-dynamic";

// GET /api/learning/elasticity?listingId=…&nights=30&checkIn=2026-08-01&targetPage=1
// → the price to reach the target page, marginal positions per ₪, and confidence.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const listingId = searchParams.get("listingId");
  if (!listingId) {
    return NextResponse.json({ error: "listingId required" }, { status: 400 });
  }
  const nightsRaw = searchParams.get("nights");
  const targetRaw = searchParams.get("targetPage");
  const result = elasticityForListing(listingId, {
    nights: nightsRaw ? Number(nightsRaw) : undefined,
    checkIn: searchParams.get("checkIn"),
    targetPage: targetRaw ? Number(targetRaw) : undefined,
  });
  if (!result) {
    return NextResponse.json({ error: "listing not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
