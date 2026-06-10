import { NextResponse } from "next/server";
import { elasticityForListing } from "@/lib/learning/elasticity";
import { recordPriceChange } from "@/lib/learning/dataset";
import { getListing } from "@/lib/repos/visibility";
import { setUnitRate } from "@/lib/repos/units";
import { logActivity } from "@/lib/repos/activity";
import { roundRate } from "@/lib/config/pricing";

export const dynamic = "force-dynamic";

// Apply a learned price suggestion. The server recomputes the recommendation
// (never trusts client numbers), then:
//  1. logs it in the experiment log (listing_price_changes) so Model B can
//     attribute the next scans' rank moves to this change, and
//  2. when the listing is mapped to a unit, updates the unit's current rate so
//     the in-app rate (Rates Calendar baseline, P&L, pricing engine) follows.
// Body: { listingId, nights?, targetPage? }
export async function POST(req: Request) {
  let body: { listingId?: string; nights?: number; targetPage?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.listingId) return NextResponse.json({ error: "listingId required" }, { status: 400 });

  const nights = body.nights ?? 30;
  const targetPage = Math.min(10, Math.max(1, Math.round(body.targetPage ?? 1)));
  const r = elasticityForListing(body.listingId, { nights, targetPage, bootstrap: false });
  if (!r || !r.target || r.target.nightly == null || r.current.nightly == null) {
    return NextResponse.json(
      { error: "no applicable suggestion for this listing/segment" },
      { status: 409 },
    );
  }

  const oldNightly = Math.round(r.current.nightly);
  const newNightly = roundRate(r.target.nightly);

  const change = recordPriceChange({
    listingId: body.listingId,
    oldNightly,
    newNightly,
    source: "operator",
    note: `Applied learned suggestion: ₪${oldNightly}→₪${newNightly}/n for ${nights}n stays (target page ${targetPage}, ${r.target.deltaPct ?? "?"}%, confidence ${r.confidence.level}, n=${r.confidence.n})`,
  });

  // Follow through on the mapped unit so the in-app rate reflects the decision.
  const unitId = getListing(body.listingId)?.unitId ?? null;
  let rateUpdated = false;
  if (unitId) {
    setUnitRate(unitId, newNightly, new Date().toISOString());
    rateUpdated = true;
  }

  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `Operator applied learned price for ${r.label}: ₪${oldNightly}→₪${newNightly}/n (target page ${targetPage}${rateUpdated ? ", unit rate updated" : ", listing not mapped to a unit — update the channel rate manually"}).`,
    level: "info",
  });

  return NextResponse.json({
    ok: true,
    listingId: body.listingId,
    unitId,
    rateUpdated,
    oldNightly,
    newNightly,
    changeId: change.id,
  });
}
