import { NextResponse } from "next/server";
import { getScanConfig } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Consumed by the scraper box: active profiles, each with its listings.
export async function GET() {
  return NextResponse.json({ profiles: getScanConfig() });
}
