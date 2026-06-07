import { NextResponse } from "next/server";
import { getBridgeView, type Period } from "@/lib/repos/bridge";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get("period");
  const period: Period = p === "month" || p === "quarter" ? p : "year";
  return NextResponse.json(getBridgeView(period));
}
