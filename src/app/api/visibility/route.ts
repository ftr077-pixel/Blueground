import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Dashboard data: profiles + every tracked listing with its latest scan.
export async function GET() {
  return NextResponse.json(getDashboard());
}
