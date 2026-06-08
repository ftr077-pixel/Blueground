import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/repos/visibility";
import { learnedRec } from "@/lib/learning/elasticity";

export const dynamic = "force-dynamic";

// Dashboard data: profiles + every tracked listing with its latest scan, plus a
// compact learned recommendation per listing (the price to reach the well-ranked
// page) that recommend() uses in place of the flat step when it's confident.
export async function GET() {
  const dash = getDashboard();
  const targetPage = dash.pricingRules.rankWellPage || 1;
  const listings = dash.listings.map((l) => ({
    ...l,
    learned: learnedRec(l.id, dash.primaryStay, targetPage),
  }));
  return NextResponse.json({ ...dash, listings });
}
