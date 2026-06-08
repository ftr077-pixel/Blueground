import { NextResponse } from "next/server";
import { upsertReservations, reservationStats, type ReservationInput } from "@/lib/repos/reservations";

export const dynamic = "force-dynamic";

/**
 * Ingest actual reservations from the MiniHotel reader running on the box.
 *
 * This is the stable seam for live revenue actuals: a small job on the box calls
 * MiniHotel's Content & Data API, normalizes each booking, and POSTs clean rows
 * here. Mirrors /api/rates/snapshot — shared-key auth via SCRAPER_API_KEY.
 *
 * Body: { reservations: [{ id, roomType?|unitId?, checkIn, checkOut, revenue, currency?, status? }] }
 * Dates are YYYY-MM-DD; checkOut is exclusive; revenue is room revenue over the stay.
 */
export async function POST(req: Request) {
  const required = process.env.SCRAPER_API_KEY;
  if (required) {
    if (req.headers.get("x-scraper-key") !== required) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[reservations] SCRAPER_API_KEY not set — accepting snapshot without auth (dev only)");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rows = (body as { reservations?: unknown }).reservations;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "missing reservations[]" }, { status: 400 });
  }

  const { recorded, skipped } = upsertReservations(rows as ReservationInput[]);
  const stats = reservationStats();
  return NextResponse.json({
    ok: true,
    recorded,
    skipped,
    counted: stats.count,
    months: stats.months,
    revenue: stats.revenue,
  });
}
