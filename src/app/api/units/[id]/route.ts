import { NextResponse } from "next/server";
import { deleteUnit } from "@/lib/repos/units";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  deleteUnit(params.id);
  return NextResponse.json({ ok: true });
}
