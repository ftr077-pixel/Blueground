import { NextResponse } from "next/server";
import { reservationReport } from "@/lib/repos/reservations";

export const dynamic = "force-dynamic";

// Reservation audit: every booking with its VAT basis + counted/excluded reason,
// monthly NET totals (matching the P&L), and this month's revenue. Use ?month=YYYY-MM
// to pick the "current" month (defaults to the server's current month).
export async function GET(req: Request) {
  const month = new URL(req.url).searchParams.get("month") ?? undefined;
  return NextResponse.json(reservationReport(month));
}
