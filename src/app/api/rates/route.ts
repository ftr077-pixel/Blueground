import { NextResponse } from "next/server";
import {
  getCalendar,
  upsertOverride,
  applyOverrideRange,
  clearedReplacements,
  rebaseFuturePrices,
  unavailableDatesForUnit,
  unitExists,
  type OverridePatch,
  type RangeOverride,
  type AppliedCell,
} from "@/lib/repos/rates";
import { effectiveRulesForUnit } from "@/lib/pricing/rules-config";
import { logActivity } from "@/lib/repos/activity";
import { setUnitBaseRate, setUnitMinMaxRates, listUnits as listAllUnits } from "@/lib/repos/units";
import { UNIT_PRICING_DEFAULTS, roundRate } from "@/lib/config/pricing";
import { pushRatesToMiniHotel, type PushResult } from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Hotel-local (Asia/Jerusalem) today — UTC would start the calendar on
// yesterday for the first 2-3 hours of each Israeli day.
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

/** "No Price Updates For Unavailable Nights": for units with the freeze ON,
 *  strip the price field from push items on booked/blocked dates so the last
 *  synced rate stays put (min-stay / availability fields still flow). Returns
 *  how many nights were frozen. */
function freezeUnavailablePrices(
  items: Array<{ unitId: string; date: string; price?: number | null; minNights?: number | null; closed?: boolean | null }>,
): number {
  const byUnit = new Map<string, Set<string>>();
  let frozen = 0;
  const units = new Map(listAllUnits().map((u) => [u.id, u]));
  for (const it of items) {
    if (it.price == null) continue;
    // A push that simultaneously OPENS the night isn't frozen — the night is
    // becoming available again, which is exactly when updates resume.
    if (it.closed === false) continue;
    let unavail = byUnit.get(it.unitId);
    if (!unavail) {
      const u = units.get(it.unitId);
      if (!u || !effectiveRulesForUnit(u).freezeUnavailable.enabled) {
        byUnit.set(it.unitId, new Set());
        continue;
      }
      unavail = unavailableDatesForUnit(it.unitId, todayLocal(), 430);
      byUnit.set(it.unitId, unavail);
    }
    if (unavail.has(it.date)) {
      it.price = undefined;
      frozen++;
    }
  }
  return frozen;
}

/** Rebuild a unit's forward derived prices and push them to MiniHotel — the
 *  shared tail of every unit-level anchor edit (Base, price floor/ceiling). */
async function rebaseAndPush(
  unitId: string,
): Promise<{ repriced: number; push?: PushResult; pushTxt: string }> {
  const repriced = rebaseFuturePrices(unitId);
  let push: PushResult | undefined;
  if (repriced.length) {
    push = await pushRatesToMiniHotel(
      repriced.map((r) => ({ unitId, date: r.date, price: r.price, minNights: r.minStay })),
    );
  }
  const pushTxt = !push
    ? "no future nights to reprice"
    : push.ok
      ? `pushed ${push.pushed} night(s) to MiniHotel`
      : `NOT pushed — ${push.message || push.errors.join("; ") || "MiniHotel error"}`;
  return { repriced: repriced.length, push, pushTxt };
}

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
    pricePctMode?: "fixed" | "dynamic";
    expiresOn?: string | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    note?: string | null;
    clear?: boolean;
    applyToGroup?: boolean;
    // shared fields
    price?: number | null;
    minNights?: number | null;
    closed?: boolean | null;
    // unit base-rate shape
    baseRate?: number;
    // unit floor/ceiling shape (null = clear the pin back to auto)
    minRate?: number | null;
    maxRate?: number | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // ---- unit base-rate shape: { unitId, baseRate } ----------------------------
  // The anchor every derived nightly price builds from (PriceLabs "Base").
  if (body.baseRate !== undefined) {
    const { unitId } = body;
    const rate = Math.round(Number(body.baseRate));
    if (!unitId) {
      return NextResponse.json({ error: "unitId required" }, { status: 400 });
    }
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) {
      return NextResponse.json({ error: "baseRate must be a positive number" }, { status: 400 });
    }
    if (!unitExists(unitId)) {
      return NextResponse.json({ error: "unknown unit" }, { status: 404 });
    }
    setUnitBaseRate(unitId, rate);
    // Rebuild every future night from the new anchor (synced prices are
    // superseded; manual pins and sold/closed nights are left alone), then
    // push the repriced nights to MiniHotel like any other calendar edit.
    const { repriced, push, pushTxt } = await rebaseAndPush(unitId);
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Rates Calendar · ${unitId}: base rate set to ₪${rate} — ${repriced} future night(s) rebuilt from the new anchor (${pushTxt}).`,
      level: push && !push.ok ? "warning" : "success",
    });
    return NextResponse.json({ ok: true, repriced, push });
  }

  // ---- unit floor/ceiling shape: { unitId, minRate?, maxRate? } ---------------
  // Pin the unit's price floor / ceiling (PriceLabs "Min/Max Price" next to
  // Base). Pinned bounds survive Base edits; null clears a pin so the bound
  // follows Base at the default band again. The forward calendar rebuilds and
  // re-pushes, exactly like a Base edit.
  if (body.minRate !== undefined || body.maxRate !== undefined) {
    const { unitId } = body;
    if (!unitId) {
      return NextResponse.json({ error: "unitId required" }, { status: 400 });
    }
    const unit = listAllUnits().find((u) => u.id === unitId);
    if (!unit) {
      return NextResponse.json({ error: "unknown unit" }, { status: 404 });
    }
    const norm = (v: number | null): number | null => (v === null ? null : Math.round(Number(v)));
    const bad = (v: number | null | undefined) =>
      v != null && (!Number.isFinite(v) || v <= 0 || v > 100000);
    const minPatch = body.minRate !== undefined ? norm(body.minRate) : undefined;
    const maxPatch = body.maxRate !== undefined ? norm(body.maxRate) : undefined;
    if (bad(minPatch) || bad(maxPatch)) {
      return NextResponse.json(
        { error: "minRate/maxRate must be positive numbers (or null to clear the pin)" },
        { status: 400 },
      );
    }
    // Validate the band the unit would END UP with (pins + auto fallbacks).
    const effMin =
      minPatch !== undefined
        ? (minPatch ?? roundRate(unit.baseRate * UNIT_PRICING_DEFAULTS.floorPctOfBase))
        : unit.minRate;
    const effMax =
      maxPatch !== undefined
        ? (maxPatch ?? roundRate(unit.baseRate * UNIT_PRICING_DEFAULTS.ceilingPctOfBase))
        : unit.maxRate;
    if (effMax > 0 && effMin > effMax) {
      return NextResponse.json(
        { error: `min price ₪${effMin} can't exceed max price ₪${effMax}` },
        { status: 400 },
      );
    }
    setUnitMinMaxRates(unitId, {
      ...(minPatch !== undefined ? { minRate: minPatch } : {}),
      ...(maxPatch !== undefined ? { maxRate: maxPatch } : {}),
    });
    const { repriced, push, pushTxt } = await rebaseAndPush(unitId);
    const parts: string[] = [];
    if (minPatch !== undefined)
      parts.push(minPatch == null ? "min price → auto (80% of Base)" : `min price pinned at ₪${minPatch}`);
    if (maxPatch !== undefined)
      parts.push(maxPatch == null ? "max price → auto (120% of Base)" : `max price pinned at ₪${maxPatch}`);
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Rates Calendar · ${unitId}: ${parts.join(", ")} — ${repriced} future night(s) rebuilt (${pushTxt}).`,
      level: push && !push.ok ? "warning" : "success",
    });
    return NextResponse.json({ ok: true, repriced, push });
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
    // Group-level DSO (PriceLabs account/group overrides): fan the same range
    // out to every listing attached to this unit's group customization.
    let targetIds = [unitId];
    let groupLabel: string | null = null;
    if (body.applyToGroup) {
      const all = listAllUnits();
      const me = all.find((u) => u.id === unitId);
      const g = me?.group ?? me?.subgroup ?? null;
      if (!g) {
        return NextResponse.json({ error: "unit has no customization group" }, { status: 400 });
      }
      groupLabel = g;
      targetIds = all.filter((u) => u.group === g || u.subgroup === g).map((u) => u.id);
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
      // "dynamic" = % of recommended (reapplied at read, stays dynamic);
      // default "fixed" = % of base materialized into a static price.
      range.pricePctMode = body.pricePctMode === "dynamic" ? "dynamic" : "fixed";
    }
    if (body.expiresOn !== undefined) {
      if (body.expiresOn !== null && !DATE_RE.test(String(body.expiresOn))) {
        return NextResponse.json({ error: "expiresOn must be YYYY-MM-DD or null" }, { status: 400 });
      }
      range.expiresOn = body.expiresOn === null ? null : String(body.expiresOn);
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
      range.expiresOn !== undefined ||
      range.note !== undefined;
    if (!hasField) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const applied = { nights: 0, unresolved: 0 };
    const items: { unitId: string; date: string; price?: number | null; minNights?: number | null; closed?: boolean | null }[] = [];
    try {
      for (const id of targetIds) {
        const res: { nights: number; written: AppliedCell[]; unresolved: number } =
          applyOverrideRange({ ...range, unitId: id });
        applied.nights += res.nights;
        applied.unresolved += res.unresolved;
        for (const w of res.written) {
          items.push({ unitId: id, date: w.date, price: w.price, minNights: w.minNights, closed: w.closed });
        }
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "range update failed" },
        { status: 400 },
      );
    }
    const nights = applied.nights;

    // Push the written nights to MiniHotel (Reverse ARI). On clear, `written`
    // carries the REPLACEMENT defaults (derived price / default min-stay), so a
    // removed restriction is overwritten on the PMS in the same action — the
    // PriceLabs-documented footgun is "turn it off and the last pushed value
    // lingers"; we re-push instead. Nights that only changed local-only
    // guardrails (min/max price) have nothing MiniHotel can store and are skipped.
    let push: PushResult | undefined;
    const frozen = freezeUnavailablePrices(items);
    const pushable = items.filter((w) => w.price != null || w.minNights != null || w.closed != null);
    if (pushable.length) push = await pushRatesToMiniHotel(pushable);

    const parts: string[] = [];
    if (range.clear) parts.push("overrides removed — defaults re-pushed");
    if (range.price != null) parts.push(`rate ₪${range.price}`);
    if (range.pricePct !== undefined)
      parts.push(`rate ${range.pricePct > 0 ? "+" : ""}${range.pricePct}%${range.pricePctMode === "dynamic" ? " of recommended (dynamic)" : " of base (fixed)"}`);
    if (range.expiresOn !== undefined)
      parts.push(range.expiresOn ? `expires ${range.expiresOn}` : "no expiry");
    if (range.minPrice != null) parts.push(`min ₪${range.minPrice}`);
    if (range.maxPrice != null) parts.push(`max ₪${range.maxPrice}`);
    if (range.minNights != null) parts.push(`min ${range.minNights}n`);
    if (range.closed !== undefined && range.closed !== null)
      parts.push(range.closed ? "closed" : "opened");
    const dowTxt = dow && dow.length ? ` (${dow.map((d) => "SMTWTFS"[d]).join("")})` : "";
    let pushTxt = !push
      ? "staged locally"
      : push.ok
        ? `pushed ${push.pushed} night(s) to MiniHotel`
        : `NOT pushed — ${push.message || push.errors.join("; ") || "MiniHotel error"}`;
    if (applied.unresolved > 0) {
      pushTxt += `; ${applied.unresolved} night(s) have no default to send — last pushed values remain on MiniHotel`;
    }
    if (frozen > 0) {
      pushTxt += `; ${frozen} unavailable night(s) kept their last synced price (freeze)`;
    }
    const who = groupLabel ? `group "${groupLabel}" (${targetIds.length} listings)` : unitId;
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Rates Calendar · ${who} ${from}→${to}${dowTxt}: ${parts.join(", ")} — ${nights} night(s) (${pushTxt}).`,
      level: (push && !push.ok) || applied.unresolved > 0 ? "warning" : "success",
    });

    return NextResponse.json({
      ok: true,
      nights,
      units: targetIds.length,
      push,
      unresolved: applied.unresolved,
    });
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

  // Push the edit straight to MiniHotel (Reverse ARI). Fields explicitly
  // cleared (null) push their replacement default — removing a restriction
  // must overwrite it on the PMS, not leave the last pushed value live.
  const repl = clearedReplacements(unitId, date, patch);
  const singleItems = [
    {
      unitId,
      date,
      price: patch.price === null ? (repl.price ?? null) : patch.price,
      minNights: patch.minNights === null ? (repl.minNights ?? null) : patch.minNights,
      closed: patch.closed === null ? (repl.closed ?? null) : patch.closed,
    },
  ];
  freezeUnavailablePrices(singleItems);
  const push = await pushRatesToMiniHotel(singleItems);

  const parts: string[] = [];
  if (patch.price !== undefined && patch.price !== null) parts.push(`rate ₪${patch.price}`);
  if (patch.minNights !== undefined && patch.minNights !== null) parts.push(`min ${patch.minNights}n`);
  if (patch.closed !== undefined) parts.push(patch.closed ? "closed" : "opened");
  const pushTxt = push.ok
    ? "pushed to MiniHotel"
    : `NOT pushed — ${push.message || push.errors.join("; ") || "MiniHotel error"}`;
  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `Rates Calendar · ${unitId} ${date}: ${parts.join(", ")} (manual edit — ${pushTxt}).`,
    level: push.ok ? "success" : "warning",
  });

  return NextResponse.json({ ok: true, push });
}
