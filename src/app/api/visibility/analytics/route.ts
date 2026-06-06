import { NextResponse } from "next/server";
import { computeMovers, portfolioTrend } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ trend: portfolioTrend(), movers: computeMovers() });
}
