import { NextResponse } from "next/server";
import { getBridgeView, type Period } from "@/lib/repos/bridge";
import { ensureFreshReservations } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // The bridge overlays reservation revenue as actuals — keep them re-checked.
  ensureFreshReservations();
  const sp = new URL(req.url).searchParams;
  const p = sp.get("period");
  const period: Period = p === "month" || p === "quarter" ? p : "year";
  const base = sp.get("base") === "1";
  return NextResponse.json(getBridgeView(period, base));
}
