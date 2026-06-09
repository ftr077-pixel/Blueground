import { NextResponse } from "next/server";
import { autoMatchUnitsToListings } from "@/lib/integrations/match";

export const dynamic = "force-dynamic";

// Auto-link unlinked apartments to Airbnb listings by name/address similarity.
export async function POST() {
  const { matched, proposals } = autoMatchUnitsToListings();
  return NextResponse.json({ ok: true, matched, proposals });
}
