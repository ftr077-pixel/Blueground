import { NextResponse } from "next/server";
import { importUnits } from "@/lib/repos/units";

export const dynamic = "force-dynamic";

interface ImportBody {
  text?: string;
  // commit=false (default) is a dry run: it returns the column mapping and the
  // per-row create/update plan without writing anything.
  commit?: boolean;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ImportBody | null;
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  const result = importUnits(body.text, body.commit === true);
  return NextResponse.json(result, { status: result.committed ? 201 : 200 });
}
