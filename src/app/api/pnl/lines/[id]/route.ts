import { NextResponse } from "next/server";
import { deletePnlLine, updatePnlLine, type PnlLineInput } from "@/lib/repos/pnl";

export const dynamic = "force-dynamic";

type LinePatch = Partial<PnlLineInput> & { active?: boolean };

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const patch = (await req.json().catch(() => null)) as LinePatch | null;
  if (!patch) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  updatePnlLine(params.id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  deletePnlLine(params.id);
  return NextResponse.json({ ok: true });
}
