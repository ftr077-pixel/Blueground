import { NextResponse } from "next/server";
import { listUnits, listPricingHistory } from "@/lib/repos/units";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    units: listUnits(),
    history: listPricingHistory(undefined, 30),
  });
}
