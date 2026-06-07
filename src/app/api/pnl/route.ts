import { NextResponse } from "next/server";
import { computeForecast } from "@/lib/repos/pnl";

export const dynamic = "force-dynamic";

// The full computed forecast: month columns, line-item rows, totals and the
// assumptions/basis behind them.
export async function GET() {
  return NextResponse.json(computeForecast());
}
