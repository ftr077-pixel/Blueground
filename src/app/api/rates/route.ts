import { NextResponse } from "next/server";
import {
  getCalendar,
  upsertOverride,
  applyOverrideRange,
  unitExists,
  type OverridePatch,
  type RangeOverride,
} from "@/lib/repos/rates";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Hotel-local (Asia/Jerusalem) today — UTC would start the calendar on
// yesterday for the first 2-3 hours of each Israeli day.
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = (url.searchParams.get("from") || todayLocal()).slice(0, 10);
  const days = Math.max(7, Math.min(120, parseInt(url.searchParams.get("days") || "35", 10) || 35));
  // Format AND validity: "2026-02-30" passes the regex but Date.parse NaNs,
  // which would throw deep in the calendar math and surface as a 500.
  if (!DATE_RE.test(from) || !Number.isFinite(Date.parse(from + "T00:00:00Z"))) {
    return NextResponse.json({ error: "bad 'from' date (YYYY-MM-DD)" }, { status: 400 });
  }
  return NextResponse.json(getCalendar(from, days));
}

export async function PATCH(req: Request) {
  let body: {
    unitId?: string;
    date?: string;
    // range shape (Date Specific Overrides panel)
    from?: string;
    to?: string;
    daysOfWeek?: number[];
    pricePct?: number;
    minPrice?: number | null;
    maxPrice?: number | null;
    note?: string | null;
    clear?: boolean;
    // shared fields
    price?: number | null;
    minNights?: number | null;
    closed?: boolean | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // ---- range shape: { unitId, from, to, ... } --------------------------------
  if (body.from !== undefined || body.to !== undefined) {
    const { unitId, from, to } = body;
    if (!unitId || !from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      return NextResponse.json(
        { error: "unitId and valid from/to dates (YYYY-MM-DD) required" },
        { status: 400 },
      );
    }
    if (!unitExists(unitId)) {
      return NextResponse.json({ error: "unknown unit" }, { status: 404 });
    }
    const dow = Array.isArray(body.daysOfWeek)
      ? body.daysOfWeek.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : undefined;

    const range: RangeOverride = { unitId, from, to, daysOfWeek: dow };
    if (body.clear) range.clear = true;
    if (body.price !== undefined)
      range.price = body.price === null ? null : Math.max(0, Math.round(Number(body.price)));
    else if (body.pricePct !== undefined) {
      const pct = Number(body.pricePct);
      if (!Number.isFinite(pct) || pct < -90 || pct > 500) {
        return NextResponse.json({ error: "pricePct must be between -90 and 500" }, { status: 400 });
      }
      range.pricePct = pct;
    }
    if (body.minPrice !== undefined)
      range.minPrice = body.minPrice === null ? null : Math.max(0, Math.round(Number(body.minPrice)));
    if (body.maxPrice !== undefined)
      range.maxPrice = body.maxPrice === null ? null : Math.max(0, Math.round(Number(body.maxPrice)));
    if (
      range.minPrice != null &&
      range.maxPrice != null &&
      range.minPrice > range.maxPrice
    ) {
      return NextResponse.json({ error: "minPrice must be ≤ maxPrice" }, { status: 400 });
    }
    if (body.minNights !== undefined)
      range.minNights = body.minNights === null ? null : Math.max(1, Math.round(Number(body.minNights)));
    if (body.closed !== undefined) range.closed = body.closed === null ? null : !!body.closed;
    if (body.note !== undefined)
      range.note = body.note === null ? null : String(body.note).slice(0, 500);

    const hasField =
      range.clear ||
      range.price !== undefined ||
      range.pricePct !== undefined ||
      range.minPrice !== undefined ||
      range.maxPrice !== undefined ||
      range.minNights !== undefined ||
      range.closed !== undefined ||
      range.note !== undefined;
    if (!hasField) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    let nights: number;
    try {
      nights = applyOverrideRange(range).nights;
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "range update failed" },
        { status: 400 },
      );
    }

    const parts: string[] = [];
    if (range.clear) parts.push("overrides removed");
    if (range.price != null) parts.push(`rate ₪${range.price}`);
    if (range.pricePct !== undefined)
      parts.push(`rate ${range.pricePct > 0 ? "+" : ""}${range.pricePct}%`);
    if (range.minPrice != null) parts.push(`min ₪${range.minPrice}`);
    if (range.maxPrice != null) parts.push(`max ₪${range.maxPrice}`);
    if (range.minNights != null) parts.push(`min ${range.minNights}n`);
    if (range.closed !== undefined && range.closed !== null)
      parts.push(range.closed ? "closed" : "opened");
    const dowTxt = dow && dow.length ? ` (${dow.map((d) => "SMTWTFS"[d]).join("")})` : "";
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Rates Calendar · ${unitId} ${from}→${to}${dowTxt}: ${parts.join(", ")} — ${nights} night(s) (staged locally, not yet pushed to MiniHotel).`,
      level: "info",
    });

    return NextResponse.json({ ok: true, nights });
  }

  // ---- legacy single-date shape: { unitId, date, ... } ------------------------
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
