import { NextResponse } from "next/server";
import { occupancyByMonth } from "@/lib/repos/occupancy";

export const dynamic = "force-dynamic";

// Occupancy by month from the stored ARI booking snapshot (real bookings, no
// revenue). ?month=YYYY-MM picks the "current" month (defaults to this month).
export async function GET(req: Request) {
  const month = new URL(req.url).searchParams.get("month") ?? undefined;
  return NextResponse.json(occupancyByMonth(month));
}
