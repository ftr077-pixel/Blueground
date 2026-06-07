import { NextResponse } from "next/server";
import { listUnits, listPricingHistory } from "@/lib/repos/units";
import { marketRateBands, marketMinNightsBenchmark } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    units: listUnits(),
    history: listPricingHistory(undefined, 30),
    market: {
      bands: marketRateBands(),
      minNights: marketMinNightsBenchmark(),
    },
  });
}
