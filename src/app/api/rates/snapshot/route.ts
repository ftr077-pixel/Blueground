import { NextResponse } from "next/server";
import { upsertOverride, unitExists, type OverridePatch } from "@/lib/repos/rates";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ingest a real ARI snapshot from the MiniHotel reader running on the box.
 *
 * This is the seam for live data: a small job on the box calls MiniHotel Bulk ARI
 * (`POST /gds`, ResponseType 05), maps each <Day> to a cell, and POSTs them here.
 * Mirrors /api/visibility/snapshot — shared-key auth via SCRAPER_API_KEY.
 *
 * Body: { source?: "minihotel", cells: [{ unitId, date, price?, available?, minNights?, closed?, booked? }] }
 * (unitId maps to a MiniHotel RoomTypeCode; keep that mapping on the box for now.)
 */
export async function POST(req: Request) {
  const required = process.env.SCRAPER_API_KEY;
  if (required) {
    if (req.headers.get("x-scraper-key") !== required) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[rates] SCRAPER_API_KEY not set — accepting snapshot without auth (dev only)");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const cells = (body as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) {
    return NextResponse.json({ error: "missing cells[]" }, { status: 400 });
  }

  let recorded = 0;
  let skipped = 0;
  for (const raw of cells) {
    const c = raw as {
      unitId?: string;
      date?: string;
      price?: number | null;
      available?: number | null;
      minNights?: number | null;
      closed?: boolean | null;
      booked?: boolean | null;
    };
    if (!c.unitId || !c.date || !DATE_RE.test(c.date) || !unitExists(c.unitId)) {
      skipped++;
      continue;
    }
    // Coerce/validate every field (mirroring the PATCH handler; null stays an
    // explicit "clear this override"): the payload is external input, and
    // binding a string/NaN throws — failing the whole batch — while a NaN that
    // slips through stores NULL over real data.
    const patch: OverridePatch = {};
    if (c.price === null) patch.price = null;
    else if (c.price !== undefined && Number.isFinite(Number(c.price))) {
      patch.price = Math.max(0, Math.round(Number(c.price)));
    }
    if (c.available === null) patch.available = null;
    else if (c.available !== undefined && Number.isFinite(Number(c.available))) {
      patch.available = Math.max(0, Math.round(Number(c.available)));
    }
    if (c.minNights === null) patch.minNights = null;
    else if (c.minNights !== undefined && Number.isFinite(Number(c.minNights))) {
      patch.minNights = Math.max(1, Math.round(Number(c.minNights)));
    }
    if (c.closed !== undefined) patch.closed = c.closed === null ? null : !!c.closed;
    if (c.booked !== undefined) patch.booked = c.booked === null ? null : !!c.booked;
    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }
    upsertOverride(c.unitId, c.date, patch, "minihotel");
    recorded++;
  }

  return NextResponse.json({ ok: true, recorded, skipped });
}
