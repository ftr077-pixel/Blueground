import { NextResponse } from "next/server";
import {
  getCalendar,
  upsertOverride,
  unitExists,
  type OverridePatch,
} from "@/lib/repos/rates";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayUTC = () => new Date().toISOString().slice(0, 10);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = (url.searchParams.get("from") || todayUTC()).slice(0, 10);
  const days = Math.max(7, Math.min(120, parseInt(url.searchParams.get("days") || "35", 10) || 35));
  if (!DATE_RE.test(from)) {
    return NextResponse.json({ error: "bad 'from' date (YYYY-MM-DD)" }, { status: 400 });
  }
  return NextResponse.json(getCalendar(from, days));
}

export async function PATCH(req: Request) {
  let body: {
    unitId?: string;
    date?: string;
    price?: number | null;
    minNights?: number | null;
    closed?: boolean | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { unitId, date, price, minNights, closed } = body;
  if (!unitId || !date || !DATE_RE.test(date)) {
    return NextResponse.json({ error: "unitId and valid date (YYYY-MM-DD) required" }, { status: 400 });
  }
  if (!unitExists(unitId)) {
    return NextResponse.json({ error: "unknown unit" }, { status: 404 });
  }

  const patch: OverridePatch = {};
  if (price !== undefined) patch.price = price === null ? null : Math.max(0, Math.round(Number(price)));
  if (minNights !== undefined)
    patch.minNights = minNights === null ? null : Math.max(1, Math.round(Number(minNights)));
  if (closed !== undefined) patch.closed = closed === null ? null : !!closed;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  upsertOverride(unitId, date, patch, "manual");

  const parts: string[] = [];
  if (patch.price !== undefined && patch.price !== null) parts.push(`rate ₪${patch.price}`);
  if (patch.minNights !== undefined && patch.minNights !== null) parts.push(`min ${patch.minNights}n`);
  if (patch.closed !== undefined) parts.push(patch.closed ? "closed" : "opened");
  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `Rates Calendar · ${unitId} ${date}: ${parts.join(", ")} (manual edit — staged locally, not yet pushed to MiniHotel).`,
    level: "info",
  });

  return NextResponse.json({ ok: true });
}
