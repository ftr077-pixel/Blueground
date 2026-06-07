import { NextResponse } from "next/server";
import { getAssumptions, setAssumptions, type PnlAssumptions } from "@/lib/repos/pnl";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getAssumptions());
}

export async function POST(req: Request) {
  const patch = (await req.json().catch(() => null)) as Partial<PnlAssumptions> | null;
  if (!patch) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  return NextResponse.json(setAssumptions(patch));
}
