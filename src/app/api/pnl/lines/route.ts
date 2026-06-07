import { NextResponse } from "next/server";
import { createPnlLine, listPnlLines, type PnlLineInput } from "@/lib/repos/pnl";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ lines: listPnlLines() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Partial<PnlLineInput> | null;
  if (!body || !body.label || !body.label.trim()) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  const line = createPnlLine({
    label: body.label,
    category: body.category === "revenue" ? "revenue" : "cost",
    section: body.section,
    monthlyAmount: typeof body.monthlyAmount === "number" ? body.monthlyAmount : 0,
    growthPct: typeof body.growthPct === "number" ? body.growthPct : 0,
  });
  return NextResponse.json(line);
}
