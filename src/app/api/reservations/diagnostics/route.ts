import { NextResponse } from "next/server";
import { reservationDiagnostics } from "@/lib/repos/reservations";
import { reservationFeedStatus } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// Feed-freshness forensics: when did the last live MiniHotel verification
// happen (and did it fail), how many bookings were CREATED each month, the
// newest bookings on file, and the raw status distribution. The place to look
// when the booking curves stop moving.
export async function GET() {
  try {
    return NextResponse.json({
      feed: reservationFeedStatus(),
      ...reservationDiagnostics(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build diagnostics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
