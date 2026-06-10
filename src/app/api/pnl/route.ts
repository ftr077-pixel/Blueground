import { NextResponse } from "next/server";
import { computeForecast } from "@/lib/repos/pnl";
import { ensureFreshReservations } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

// The full computed forecast: month columns, line-item rows, totals and the
// assumptions/basis behind them.
export async function GET() {
  // Money is re-checked, not remembered: stale revenue actuals trigger a
  // background re-pull from MiniHotel (extensions, price changes, cancellations).
  ensureFreshReservations();
  return NextResponse.json(computeForecast());
}
