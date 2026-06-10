import { NextResponse } from "next/server";
import { suggestionList } from "@/lib/learning/elasticity";
import { getSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// The actionable price-move queue: only listings whose learned target differs
// from their current price by >= minAbsPct, with at least medium confidence.
// ?nights= (default: primary stay) ?targetPage= (default 1) ?minAbsPct= (default 2)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const nights =
    Number(searchParams.get("nights")) || Number(getSetting("primary_stay")) || 30;
  const targetPage = Math.min(10, Math.max(1, Number(searchParams.get("targetPage")) || 1));
  const minAbsPct = Math.max(0.5, Number(searchParams.get("minAbsPct")) || 2);
  return NextResponse.json(suggestionList(nights, targetPage, minAbsPct));
}
