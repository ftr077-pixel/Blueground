import { NextResponse } from "next/server";
import {
  computeOpsForecast,
  setOpsAssumptions,
  type OpsAssumptions,
} from "@/lib/repos/ops-forecast";
import { ensureFreshReservations } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// The operating forecast: revenue already sold + expected pickup, costed with
// the operator's real unit economics, next to the locked Bridge plan.
export async function GET() {
  // Money is re-checked, not remembered — a stale book would understate both
  // the sold revenue and the checkouts that drive the variable costs.
  ensureFreshReservations();
  return NextResponse.json(computeOpsForecast());
}

// Update the operating assumptions (partial patch), then return the recomputed
// forecast so the UI updates from one round-trip.
export async function PATCH(req: Request) {
  let body: Partial<OpsAssumptions> = {};
  try {
    body = (await req.json()) as Partial<OpsAssumptions>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  setOpsAssumptions(body);
  return NextResponse.json(computeOpsForecast());
}
