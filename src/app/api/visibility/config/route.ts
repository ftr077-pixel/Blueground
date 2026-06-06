import { NextResponse } from "next/server";
import { getScanConfig, getSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Consumed by the scraper box: active profiles + the availability cutoff.
export async function GET() {
  return NextResponse.json({
    profiles: getScanConfig(),
    availabilityDays: Number(getSetting("availability_days")) || 90,
  });
}
