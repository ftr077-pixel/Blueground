import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ proxyUrl: getSetting("proxy_url") ?? "" });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { proxyUrl?: string } | null;
  if (body == null) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  setSetting("proxy_url", (body.proxyUrl ?? "").trim());
  return NextResponse.json({ ok: true });
}
