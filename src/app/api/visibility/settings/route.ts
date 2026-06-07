import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

function num(key: string, def: number) {
  const v = getSetting(key);
  return v != null && v !== "" ? Number(v) : def;
}

export async function GET() {
  return NextResponse.json({
    proxyUrl: getSetting("proxy_url") ?? "",
    availabilityDays: num("availability_days", 90),
    primaryStay: num("primary_stay", 30),
    bgFeePct: num("bg_fee_pct", 6),
    defaultUtilities: num("default_utilities", 1000),
    defaultCleaning: num("default_cleaning", 500),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    proxyUrl?: string;
    availabilityDays?: number;
    primaryStay?: number;
    bgFeePct?: number;
    defaultUtilities?: number;
    defaultCleaning?: number;
  } | null;
  if (body == null) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  if (body.proxyUrl !== undefined) setSetting("proxy_url", (body.proxyUrl ?? "").trim());
  if (body.availabilityDays !== undefined)
    setSetting("availability_days", String(Math.max(1, Math.round(body.availabilityDays))));
  if (body.primaryStay !== undefined)
    setSetting("primary_stay", String(Math.max(1, Math.round(body.primaryStay))));
  if (body.bgFeePct !== undefined)
    setSetting("bg_fee_pct", String(Math.max(0, Math.min(100, body.bgFeePct))));
  if (body.defaultUtilities !== undefined)
    setSetting("default_utilities", String(Math.max(0, Math.round(body.defaultUtilities))));
  if (body.defaultCleaning !== undefined)
    setSetting("default_cleaning", String(Math.max(0, Math.round(body.defaultCleaning))));
  return NextResponse.json({ ok: true });
}
