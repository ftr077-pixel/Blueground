import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    proxyUrl: getSetting("proxy_url") ?? "",
    availabilityDays: Number(getSetting("availability_days")) || 90,
    primaryStay: Number(getSetting("primary_stay")) || 30,
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    proxyUrl?: string;
    availabilityDays?: number;
    primaryStay?: number;
  } | null;
  if (body == null) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  if (body.proxyUrl !== undefined) setSetting("proxy_url", (body.proxyUrl ?? "").trim());
  if (body.availabilityDays !== undefined)
    setSetting("availability_days", String(Math.max(1, Math.round(body.availabilityDays))));
  if (body.primaryStay !== undefined)
    setSetting("primary_stay", String(Math.max(1, Math.round(body.primaryStay))));
  return NextResponse.json({ ok: true });
}
