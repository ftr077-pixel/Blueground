import { NextResponse } from "next/server";
import { getScanConfig, getSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Consumed by the scraper box: active profiles + the availability cutoff.
// This route bypasses the dashboard login (middleware BYPASS), so it guards
// itself with the shared SCRAPER_API_KEY like the snapshot endpoints — the
// payload maps street addresses to Airbnb listing ids and shouldn't be public.
// Open when the key isn't set (local dev), same as its siblings.
export async function GET(req: Request) {
  const required = process.env.SCRAPER_API_KEY;
  if (required && req.headers.get("x-scraper-key") !== required) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    profiles: getScanConfig(),
    availabilityDays: Number(getSetting("availability_days")) || 90,
  });
}
