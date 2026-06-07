import { NextResponse } from "next/server";
import { clearOverrides, setOverride } from "@/lib/repos/bridge";

export const dynamic = "force-dynamic";

interface Body {
  key?: string;
  value?: number | null;
  reset?: boolean;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  if (body.reset) {
    clearOverrides();
    return NextResponse.json({ ok: true, overrides: {} });
  }
  if (!body.key) return NextResponse.json({ error: "key required" }, { status: 400 });
  const overrides = setOverride(body.key, body.value ?? null);
  return NextResponse.json({ ok: true, overrides });
}
