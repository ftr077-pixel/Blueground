import { NextResponse } from "next/server";
import { listPriceChanges, recordPriceChange } from "@/lib/learning/dataset";

export const dynamic = "force-dynamic";

// GET  ?listingId=…  → the listing's logged price changes (experiment log).
// POST { listingId, oldNightly?, newNightly?, source?, note? } → log a change so
// Model B can attribute the next scan's rank move to it.
export async function GET(req: Request) {
  const listingId = new URL(req.url).searchParams.get("listingId");
  if (!listingId) return NextResponse.json({ error: "listingId required" }, { status: 400 });
  return NextResponse.json({ changes: listPriceChanges(listingId) });
}

export async function POST(req: Request) {
  let body: {
    listingId?: string;
    oldNightly?: number;
    newNightly?: number;
    source?: string;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.listingId) return NextResponse.json({ error: "listingId required" }, { status: 400 });
  const change = recordPriceChange({
    listingId: body.listingId,
    oldNightly: body.oldNightly ?? null,
    newNightly: body.newNightly ?? null,
    source: body.source || "operator",
    note: body.note ?? null,
  });
  return NextResponse.json({ ok: true, change });
}
