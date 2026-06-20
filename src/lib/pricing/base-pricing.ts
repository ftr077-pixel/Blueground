// Suggest a per-unit BASE (anchor) rate from the operator's costs. The base is
// the "typical night" the engine builds every other price from, so we anchor it
// to the market ADR but never let it fall below the nightly that still clears a
// target margin once rent + bills + fees are paid. Pure-ish: reads units, their
// linked listing's costs (rent/utilities/cleaning), the cost defaults, and the
// cached AirROI market ADR. Apply via setUnitBaseRate / PATCH /api/rates.

import { listUnits } from "@/lib/repos/units";
import { listListings, costDefaults, type TrackedListing } from "@/lib/repos/visibility";
import { effectiveNeighborhood } from "@/lib/pricing/rules-config";
import { listMarketSnapshots } from "@/lib/repos/market";
import { roundRate } from "@/lib/config/pricing";

export type BaseMethod = "marketFloor" | "costPlus" | "vacancy" | "blend";
export const BASE_METHODS: BaseMethod[] = ["marketFloor", "costPlus", "vacancy", "blend"];

export interface BaseSuggestion {
  unitId: string;
  name: string;
  neighborhood: string;
  /** Costs (rent from the linked listing; utilities/cleaning fall back to defaults). */
  rentKnown: boolean;
  rent: number | null;
  utilities: number;
  cleaning: number;
  feePct: number; // BG + Airbnb, as a fraction
  monthlyDiscountPct: number; // the LOS discount applied to a 30-night stay
  currentBase: number;
  /** Cost-plus base: the nightly that clears the target margin at full occupancy. */
  costFloor: number | null;
  /** Market ADR for the unit's neighborhood (AirROI), or null. */
  marketADR: number | null;
  /** Forward occupancy used by the vacancy method / shown for context. */
  occupancy: number | null;
  /** The suggested base under the chosen method (null when rent is missing). */
  suggested: number | null;
  /** Projected margin / monthly profit at the suggested base. */
  projectedMarginPct: number | null;
  projectedMonthlyProfit: number | null;
  note: string | null;
}

export interface BaseSuggestionResult {
  targetMargin: number;
  method: BaseMethod;
  units: BaseSuggestion[];
}

/** Cost-plus nightly base: revenue to clear `margin` ÷ the sold-night divisor.
 *  fixed = rent + utilities + cleaning; revenue R satisfies R(1−fee) − fixed =
 *  margin·R ⇒ R = fixed / (1 − fee − margin); base = R / (30·(1 − monthlyDisc)). */
function costPlusBase(
  fixed: number,
  feePct: number,
  margin: number,
  monthlyDisc: number,
): number | null {
  const denom = 1 - feePct - margin;
  const soldDivisor = 30 * Math.max(0.01, 1 - monthlyDisc);
  if (denom <= 0 || soldDivisor <= 0) return null;
  return roundRate(fixed / denom / soldDivisor);
}

/** Margin (fraction) and monthly profit (₪) a base produces at full occupancy. */
function econAt(
  base: number,
  fixed: number,
  feePct: number,
  monthlyDisc: number,
): { margin: number | null; profit: number } {
  const revenue = base * 30 * (1 - monthlyDisc);
  const profit = revenue * (1 - feePct) - fixed;
  return { margin: revenue > 0 ? profit / revenue : null, profit: Math.round(profit) };
}

export function suggestBaseRates(opts: {
  targetMargin: number;
  method: BaseMethod;
  /** Forward occupancy per unit (0..1), for the vacancy method + display. */
  occByUnit?: Map<string, number | null>;
  /** Market weight for the blend method (0..1; default 0.6). */
  blendWeight?: number;
}): BaseSuggestionResult {
  const M = Math.max(-0.5, Math.min(0.9, opts.targetMargin));
  const blendW = Math.max(0, Math.min(1, opts.blendWeight ?? 0.6));
  const cd = costDefaults();
  const feePct = (cd.bgFeePct + cd.airbnbFeePct) / 100;

  const adrByHood = new Map<string, number>();
  for (const s of listMarketSnapshots()) {
    if (s.summary?.average_daily_rate && s.summary.average_daily_rate > 0) {
      adrByHood.set(s.neighborhood, s.summary.average_daily_rate);
    }
  }
  const listingByUnit = new Map<string, TrackedListing>();
  for (const l of listListings()) if (l.unitId) listingByUnit.set(l.unitId, l);

  const units = listUnits().map((u): BaseSuggestion => {
    const lst = listingByUnit.get(u.id) ?? null;
    const rent = lst?.monthlyRent ?? null;
    const utilities = lst?.utilities ?? cd.defaultUtilities;
    const cleaning = lst?.cleaningFee ?? cd.defaultCleaning;
    const monthlyDisc = u.monthlyDiscountPct; // what the engine applies to a 30-night stay
    const marketADR = adrByHood.get(effectiveNeighborhood(u)) ?? null;
    const occ = opts.occByUnit?.get(u.id) ?? null;

    let costFloor: number | null = null;
    let note: string | null = null;
    if (rent == null) {
      note = "set rent to price from cost";
    } else {
      const fixed = rent + utilities + cleaning;
      costFloor = costPlusBase(fixed, feePct, M, monthlyDisc);
      if (costFloor == null) note = "target margin too high for the fee structure";
    }

    let suggested: number | null = null;
    if (costFloor != null) {
      if (opts.method === "costPlus") {
        suggested = costFloor;
      } else if (opts.method === "vacancy") {
        const o = occ != null && occ > 0 ? Math.min(1, Math.max(0.4, occ)) : 0.75;
        suggested = roundRate(costFloor / o);
        note = `vacancy-adjusted at ${(o * 100).toFixed(0)}% occupancy`;
      } else if (opts.method === "blend") {
        suggested =
          marketADR != null
            ? Math.max(costFloor, roundRate(blendW * marketADR + (1 - blendW) * costFloor))
            : costFloor;
        if (marketADR == null) note = "no market data — used cost floor";
      } else {
        // marketFloor (default): ride the market ADR, never below the cost floor.
        suggested = marketADR != null ? Math.max(costFloor, roundRate(marketADR)) : costFloor;
        if (marketADR == null) note = "no market data — used cost floor";
        else if (marketADR < costFloor) note = "market below cost — held at floor";
      }
    }

    let projectedMarginPct: number | null = null;
    let projectedMonthlyProfit: number | null = null;
    if (suggested != null && rent != null) {
      const e = econAt(suggested, rent + utilities + cleaning, feePct, monthlyDisc);
      projectedMarginPct = e.margin != null ? Math.round(e.margin * 1000) / 10 : null;
      projectedMonthlyProfit = e.profit;
    }

    return {
      unitId: u.id,
      name: u.name,
      neighborhood: u.neighborhood,
      rentKnown: rent != null,
      rent,
      utilities,
      cleaning,
      feePct,
      monthlyDiscountPct: monthlyDisc,
      currentBase: u.baseRate,
      costFloor,
      marketADR: marketADR != null ? Math.round(marketADR) : null,
      occupancy: occ,
      suggested,
      projectedMarginPct,
      projectedMonthlyProfit,
      note,
    };
  });

  return { targetMargin: M, method: opts.method, units };
}
