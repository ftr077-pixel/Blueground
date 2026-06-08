import { NextResponse } from "next/server";
import {
  getMiniHotelMapping,
  setMiniHotelMapping,
  deleteMappedUnit,
} from "@/lib/repos/integrations";

export const dynamic = "force-dynamic";

function summary() {
  const rows = getMiniHotelMapping();
  return { rows, mapped: rows.filter((r) => r.roomType).length, total: rows.length };
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
