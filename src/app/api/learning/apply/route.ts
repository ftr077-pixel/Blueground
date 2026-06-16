import { NextResponse } from "next/server";
import { elasticityForListing } from "@/lib/learning/elasticity";
import { recordPriceChange } from "@/lib/learning/dataset";
import { getListing } from "@/lib/repos/visibility";
import { setUnitBaseRate } from "@/lib/repos/units";
import { applyTotalAcrossNights } from "@/lib/repos/rates";
import { logActivity } from "@/lib/repos/activity";
import { roundRate } from "@/lib/config/pricing";

export const dynamic = "force-dynamic";

type ApplyMode = "base" | "override";

// check_in + (nights-1) = the last occupied night of the stay.
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Apply a learned price suggestion. The server recomputes the recommendation
// (never trusts client numbers), logs it to the experiment log (so Model B and
// the scorecard can attribute the outcome), then writes the price the way the
// operator chose:
//   mode "base"     — set the unit's BASE (anchor) rate. The Rates Calendar,
//                     pricing engine, and P&L all rebuild from base_rate, so this
//                     is what actually moves the operative price (across all
//                     dates). (Earlier this wrote current_rate, which the engine
//                     ignores — the "nothing happens on Apply" bug.)
//   mode "override" — pin the suggested nightly for THIS check-in's stay window
//                     as dated Rates Calendar overrides; the base rate is left
//                     untouched (surgical — just those nights).
// Either way needs the listing mapped to a unit; unmapped → logged only.
// Body: { listingId, nights?, targetPage?, mode? }
export async function POST(req: Request) {
  let body: { listingId?: string; nights?: number; targetPage?: number; mode?: ApplyMode };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.listingId) return NextResponse.json({ error: "listingId required" }, { status: 400 });
  const mode: ApplyMode = body.mode === "override" ? "override" : "base";

  const nights = body.nights ?? 30;
  const targetPage = Math.min(10, Math.max(1, Math.round(body.targetPage ?? 1)));
  const r = elasticityForListing(body.listingId, { nights, targetPage, bootstrap: false });
  if (!r || !r.target || r.target.nightly == null || r.current.nightly == null) {
    return NextResponse.json(
      { error: "no applicable suggestion for this listing/segment" },
      { status: 409 },
    );
  }

  // An override needs a concrete stay window to pin.
  if (mode === "override" && !r.checkIn) {
    return NextResponse.json(
      { error: "no scanned check-in to override — use base-rate mode, or scan this listing first" },
      { status: 409 },
    );
  }

  const oldNightly = Math.round(r.current.nightly);
  const newNightly = roundRate(r.target.nightly);
  const unitId = getListing(body.listingId)?.unitId ?? null;

  const change = recordPriceChange({
    listingId: body.listingId,
    oldNightly,
    newNightly,
    source: "operator",
    note: `Applied learned suggestion (${mode}): ₪${oldNightly}→₪${newNightly}/n for ${nights}n stays (target page ${targetPage}, ${r.target.deltaPct ?? "?"}%, confidence ${r.confidence.level}, n=${r.confidence.n})`,
    // Persist the model's belief so this exact suggestion can be scored later
    // (scorecard.ts): the page we aimed for, the rank it should reach at the new
    // price, and the confidence/sample behind it.
    nights,
    targetPage,
    predictedRank: r.target.rank,
    confidence: r.confidence.level,
    n: r.confidence.n,
  });

  // Follow through on the mapped unit so the in-app price reflects the decision.
  let rateUpdated = false;
  let overrideNights = 0;
  if (unitId) {
    if (mode === "base") {
      // base_rate is the anchor every derived nightly rebuilds from.
      setUnitBaseRate(unitId, newNightly);
      rateUpdated = true;
    } else {
      try {
        // Hold the month's TOTAL (newNightly × nights) but spread it along the
        // last-minute curve instead of pinning a flat nightly — nearer nights
        // cheaper, later nights dearer, same sum.
        const total = newNightly * nights;
        const res = applyTotalAcrossNights(
          unitId,
          r.checkIn!,
          addDaysIso(r.checkIn!, Math.max(0, nights - 1)),
          total,
          `Pricing Intelligence: page ${targetPage} target (check-in ${r.checkIn}) — ₪${total} over ${nights}n, distributed by last-minute shape`,
        );
        overrideNights = res.nights;
        rateUpdated = res.nights > 0;
      } catch {
        rateUpdated = false; // unknown/stale unit mapping
      }
    }
  }

  const detail = !rateUpdated
    ? "listing not mapped to a unit — set the channel rate manually"
    : mode === "base"
      ? "base rate updated — Rates Calendar, engine & P&L follow"
      : `pinned ${overrideNights} night(s) from ${r.checkIn} in the Rates Calendar`;

  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `Operator applied learned price for ${r.label} (${mode}): ₪${oldNightly}→₪${newNightly}/n — ${detail}.`,
    level: "info",
  });

  return NextResponse.json({
    ok: true,
    mode,
    listingId: body.listingId,
    unitId,
    rateUpdated,
    overrideNights,
    oldNightly,
    newNightly,
    checkIn: r.checkIn,
    nights,
    changeId: change.id,
  });
}
