import { NextResponse } from "next/server";
import {
  getMiniHotelMapping,
  setMiniHotelMapping,
  deleteMappedUnit,
} from "@/lib/repos/integrations";
import { listListings, setUnitListing } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

function summary() {
  const rows = getMiniHotelMapping();
  const listings = listListings();
  // unitId -> the Airbnb listing currently linked to it (first wins).
  const byUnit = new Map<string, string>();
  for (const l of listings) if (l.unitId && !byUnit.has(l.unitId)) byUnit.set(l.unitId, l.id);
  return {
    rows: rows.map((r) => ({ ...r, airbnbListingId: byUnit.get(r.unitId) ?? null })),
    mapped: rows.filter((r) => r.roomType).length,
    total: rows.length,
    airbnbListings: listings.map((l) => ({ id: l.id, label: l.label, airbnbId: l.airbnbId })),
  };
}

export async function GET() {
  return NextResponse.json(summary());
}

export async function POST(req: Request) {
  let body: { mappings?: { unitId: string; roomType: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!Array.isArray(body.mappings)) {
    return NextResponse.json({ error: "mappings[] required" }, { status: 400 });
  }
  const updated = setMiniHotelMapping(body.mappings);
  return NextResponse.json({ ok: true, updated, ...summary() });
}

// Link an apartment to one of our tracked Airbnb listings (listingId = null clears).
export async function PATCH(req: Request) {
  let body: { unitId?: string; listingId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.unitId) {
    return NextResponse.json({ error: "unitId required" }, { status: 400 });
  }
  setUnitListing(body.unitId, body.listingId ?? null);
  return NextResponse.json({ ok: true, ...summary() });
}

// Remove an apartment from the Hub. By default also remembers its MiniHotel code
// (excluded list) so a later Import won't bring it back.
export async function DELETE(req: Request) {
  let body: { unitId?: string; exclude?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.unitId) {
    return NextResponse.json({ error: "unitId required" }, { status: 400 });
  }
  const ok = deleteMappedUnit(body.unitId, body.exclude !== false);
  if (!ok) return NextResponse.json({ error: "unknown unit" }, { status: 404 });
  return NextResponse.json({ ok: true, ...summary() });
}
