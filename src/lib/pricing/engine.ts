// The pricing rule engine. Turns a base rate + market context into an explained
// per-night quote: applies each enabled rule as a multiplier, clamps to the
// unit's floor/ceiling, resolves the minimum stay via its hierarchy, and honors
// any date override. Pure and deterministic given the providers.

import type { Unit } from "@/lib/repos/units";
import { PRICING_RULES, PRICING_AGENT, roundRate } from "@/lib/config/pricing";
import type { MarketProviders } from "@/lib/pricing/providers";
import {
  seasonalityRule,
  demandRule,
  pacingRule,
  occupancyRule,
  portfolioOccupancyRule,
  farOutRule,
  lastMinuteRule,
  adjacentRule,
  orphanDayPriceRule,
  resolveAdjustmentStack,
  pricingOffsetRule,
  resolveMinPrice,
  gapInfo,
  isWeekendDay,
  dayOfWeekRule,
  losDiscountForStay,
  type FactorResult,
} from "@/lib/pricing/rules";
import { SEASONALITY_SENSITIVITY } from "@/lib/config/pricing";

export type { FactorResult } from "@/lib/pricing/rules";

const DAY_MS = 86_400_000;

export interface DateQuote {
  date: string; // ISO date (YYYY-MM-DD)
  leadDays: number;
  base: number;
  factors: FactorResult[];
  rawRate: number; // base × Π factors, before floor/ceiling
  rate: number; // final nightly rate
  bound: "floor" | "ceiling" | "override" | null;
  /** The resolved price floor for this night (listing min or an advanced min-price rule). */
  minPrice: number;
  minPriceSource: string;
  minStay: number;
  minStaySource: string;
  /** Effective monthly rate (₪) for a 30-night booking after LOS discount. */
  effectiveMonthlyRate: number;
  /** Check-in/Check-out restriction flags for this weekday (CICO profiles). */
  checkinAllowed: boolean;
  checkoutAllowed: boolean;
}

function leadDaysFrom(asOf: Date, date: Date): number {
  return Math.max(0, Math.round((date.getTime() - asOf.getTime()) / DAY_MS));
}

/**
 * The full PriceLabs minimum-stay hierarchy (highest priority last to apply):
 *   Lowest Min Stay Allowed > Orphan Gap (only ever reduces; has its OWN floor,
 *   the "Lowest Orphan Gap Allowed") > Date-Specific Override > Adjacent After >
 *   Adjacent Before > Far-Out > Last-Minute > Default (recommended or custom).
 * The Adaptive Occupancy reduction applies on top of the resolved value and
 * never goes below the unit floor. `nightlyRate` feeds the booking-value
 * default rule (nights ≈ value ÷ rate).
 */
function resolveMinStay(
  unit: Unit,
  date: Date,
  leadDays: number,
  market: MarketProviders,
  cfg: typeof PRICING_RULES,
  nightlyRate: number,
): { minStay: number; source: string } {
  const r = cfg.minStayRules;
  const floor = unit.lowestMinStay;
  const cap = Math.max(1, r.highestAllowed);
  const wk = isWeekendDay(date, cfg);
  let rec: number;
  let source: string;

  // 8. Default rule
  if (r.mode === "custom") {
    if (r.custom.rule === "bookingValue" && r.custom.bookingValue > 0) {
      rec = Math.ceil(r.custom.bookingValue / Math.max(1, nightlyRate));
      source = `booking value ₪${r.custom.bookingValue}`;
    } else {
      rec = Math.max(1, wk ? r.custom.weekend : r.custom.weekday);
      source = `default ${wk ? "weekend" : "weekday"}`;
    }
  } else {
    // Recommended (dynamic): demand-flex tiers benchmarked vs the comp median.
    const tiers = PRICING_AGENT.minStayDemandTiers;
    rec = floor;
    source = `floor ${floor}n`;
    const demand = market.eventDemand(unit, date).bump;
    for (const tier of tiers) {
      if (demand >= tier.threshold) {
        rec = floor + tier.bump;
        source = tier.label;
        break;
      }
    }
    const median = market.compMedianMinNights();
    if (median && median > rec) {
      rec = Math.min(median, floor + tiers[0].bump);
      source = `market median ${median}n`;
    }
  }

  // 7. Last-minute rules (tightest matching window wins)
  const lm = r.lastMinute
    .filter((x) => x.withinDays > 0 && leadDays <= x.withinDays)
    .sort((a, b) => a.withinDays - b.withinDays)[0];
  if (lm) {
    rec = Math.max(1, wk ? lm.weekend : lm.weekday);
    source = `last-minute ≤${lm.withinDays}d`;
  }

  // 6. Far-out bookings require longer commitments
  if (leadDays > cfg.minStayHierarchy.farOutThresholdDays && cfg.minStayHierarchy.farOutNights > 0) {
    rec = cfg.minStayHierarchy.farOutNights;
    source = "far-out";
  }

  const open = !market.isBooked(unit, date);
  // 5. Adjacent BEFORE — a stay ending flush against the next booking (no gap created)
  if (r.adjacent.enabled && r.adjacent.beforeFlushFit && open) {
    let dist = 0;
    for (let k = 1; k <= 45; k++) {
      if (market.isBooked(unit, new Date(date.getTime() + k * DAY_MS))) {
        dist = k;
        break;
      }
    }
    if (dist > 0 && dist < rec) {
      rec = dist;
      source = `adjacent before (${dist}n flush)`;
    }
  }
  // 4. Adjacent AFTER — check-in right after a checkout
  if (r.adjacent.enabled && r.adjacent.afterNights > 0 && open &&
      market.isBooked(unit, new Date(date.getTime() - DAY_MS))) {
    rec = r.adjacent.afterNights;
    source = "adjacent after";
  }

  // 3. Date-Specific Override — clamped by Lowest Min Stay Allowed below
  // (PriceLabs: the lowest-allowed floor holds even against DSOs; sanctioned
  // short gap-fills go through the orphan rule and ITS floor instead).
  const ov = market.dateOverride(unit, date);
  if (ov?.minStay != null) {
    rec = ov.minStay;
    source = "override";
  }

  // 1. Lowest/Highest Min Stay Allowed (orphan below applies its own floor)
  if (rec < floor) source = `lowest allowed ${floor}n (over ${source})`;
  rec = Math.max(floor, Math.min(rec, cap));

  // Adaptive Occupancy Adjustment — own forward occupancy relatively below
  // market shortens the requirement (−1 at >10% below, −2 at >20% below).
  if (r.adaptiveOccupancy.enabled) {
    const o = market.occupancy90(unit);
    if (o) {
      const reduce = o.own < o.market * 0.8 ? 2 : o.own < o.market * 0.9 ? 1 : 0;
      if (reduce > 0 && rec > floor) {
        rec = Math.max(floor, rec - reduce);
        source += ` · adaptive −${reduce}n`;
      }
    }
  }

  // 2. Orphan gap — highest priority bar the floors; only ever REDUCES, and is
  // clamped by its own Lowest Orphan Gap Allowed (which may sit below the unit
  // floor — that's the documented way short gap-fills happen).
  if (r.orphanGap.enabled) {
    const gap = gapInfo(unit, date, market);
    if (gap && gap.len <= Math.max(1, r.orphanGap.maxGapNights)) {
      const byStrategy =
        r.orphanGap.strategy === "fixed"
          ? r.orphanGap.fixedNights
          : r.orphanGap.strategy === "gapMinus1"
            ? gap.len - 1
            : r.orphanGap.strategy === "gapMinus2"
              ? gap.len - 2
              : gap.len;
      const cand = Math.max(Math.max(1, r.orphanGap.lowestAllowed), Math.max(1, byStrategy));
      if (cand < rec) {
        rec = cand;
        source = `orphan gap ${gap.len}n`;
      }
    }
  }

  return { minStay: Math.min(rec, cap), source };
}

/** Quote a single night for a unit. */
export function quoteNight(
  unit: Unit,
  date: Date,
  market: MarketProviders,
  asOf: Date = new Date(),
  cfg: typeof PRICING_RULES = PRICING_RULES,
): DateQuote {
  const leadDays = leadDaysFrom(asOf, date);

  const factors: FactorResult[] = [];
  const add = (r: FactorResult | null) => {
    if (r) factors.push(r);
  };
  add(seasonalityRule(date, market, cfg));
  add(demandRule(unit, date, market, cfg));
  add(pacingRule(unit, market, cfg));
  add(occupancyRule(unit, date, market, cfg));
  add(portfolioOccupancyRule(unit, date, leadDays, market, cfg));
  add(farOutRule(unit, date, leadDays, market, cfg));
  // Gap/lead-time adjustment class — PriceLabs stacking: largest discount wins,
  // premiums stack, a mix applies largest discount + every premium. FIXED
  // prices (last-minute fixed, orphan fixed) are pins that bypass the stack;
  // when both fire, last-minute beats orphan-day (the PriceLabs fixed-override
  // hierarchy: date-specific > last-minute > orphan-day).
  const orphan = orphanDayPriceRule(unit, date, leadDays, market, cfg);
  const lastMin = lastMinuteRule(unit, date, leadDays, market, cfg);
  const stackCandidates: (FactorResult | null)[] = [adjacentRule(unit, date, market, cfg)];
  let pin: number | null = null;
  if (lastMin?.pin != null) {
    pin = lastMin.pin;
    factors.push(lastMin);
  } else if (lastMin) {
    stackCandidates.push(lastMin);
  }
  if (orphan?.pin != null) {
    if (pin == null) {
      pin = orphan.pin;
      factors.push(orphan);
    }
    // else: the last-minute fixed price wins; the orphan pin is suppressed.
  } else if (orphan) {
    stackCandidates.push(orphan);
  }
  for (const f of resolveAdjustmentStack(stackCandidates, unit.baseRate)) {
    factors.push(f);
  }
  add(dayOfWeekRule(date, cfg));

  // Multiplicative factors compound on the base; fixed (₪) adjustments from
  // fixed-mode rules are added after, before the floor/ceiling clamp. A pinned
  // fixed price replaces the computed raw rate outright (still clamped).
  const mult = factors.reduce((acc, f) => acc * f.factor, unit.baseRate);
  const fixedAdj = factors.reduce((acc, f) => acc + (f.add ?? 0), 0);
  const rawRate = roundRate(Math.max(0, pin ?? mult + fixedAdj));

  // Advanced Minimum Price rules resolve the floor per night (far-out/weekend
  // raise it; last-minute/orphan replace it — possibly below the listing min).
  const { min: minPrice, source: minPriceSource } = resolveMinPrice(
    unit, date, leadDays, market, cfg,
  );

  let rate = rawRate;
  let bound: DateQuote["bound"] = null;
  if (rate < minPrice) {
    rate = minPrice;
    bound = "floor";
  } else if (rate > unit.maxRate) {
    rate = unit.maxRate;
    bound = "ceiling";
  }

  // Absolute date override pins the rate outright
  const ov = market.dateOverride(unit, date);
  if (ov?.rate != null) {
    rate = roundRate(ov.rate);
    bound = "override";
    factors.push({ key: "override", label: "Date override", factor: rate / unit.baseRate, detail: ov.note ?? "operator override" });
  }

  // Pricing offset is the one adjustment that runs after EVERYTHING — the
  // clamp and even a fixed override — and may take the rate outside min/max
  // (documented PriceLabs behavior; used for channel-fee parity).
  const off = pricingOffsetRule(rate, cfg);
  if (off) {
    rate = Math.max(PRICING_AGENT.roundingStep, roundRate(off.rate));
    factors.push(off.entry);
  }

  const { minStay, source } = resolveMinStay(unit, date, leadDays, market, cfg, rate);
  const effectiveMonthlyRate = Math.round(rate * 30 * (1 - losDiscountForStay(unit, 30, cfg)));

  // Check-in/Check-out restriction for this weekday (engine-side; not pushed —
  // no verified CTA/CTD field in the MiniHotel Reverse ARI contract).
  const dow = date.getUTCDay();
  const cc = cfg.checkinCheckout;
  const checkinAllowed = !cc.enabled || cc.allowedCheckin.includes(dow);
  const checkoutAllowed = !cc.enabled || cc.allowedCheckout.includes(dow);

  return {
    date: date.toISOString().slice(0, 10),
    leadDays,
    base: unit.baseRate,
    factors,
    rawRate,
    rate,
    bound,
    minPrice,
    minPriceSource,
    minStay,
    minStaySource: source,
    effectiveMonthlyRate,
    checkinAllowed,
    checkoutAllowed,
  };
}

/** The quote used to set a unit's headline "current rate": priced at the typical
 *  MTR booking window (config.currentRateLeadDays out), not today. */
export function representativeQuote(
  unit: Unit,
  market: MarketProviders,
  asOf: Date = new Date(),
  cfg: typeof PRICING_RULES = PRICING_RULES,
): DateQuote {
  const target = new Date(asOf.getTime() + cfg.currentRateLeadDays * DAY_MS);
  return quoteNight(unit, target, market, asOf, cfg);
}

/** A forward price curve (sampled every `stepDays`) over the configured horizon. */
export function quoteCurve(
  unit: Unit,
  market: MarketProviders,
  asOf: Date = new Date(),
  stepDays = 7,
  cfg: typeof PRICING_RULES = PRICING_RULES,
): DateQuote[] {
  const out: DateQuote[] = [];
  for (let d = 0; d <= cfg.curveHorizonDays; d += stepDays) {
    out.push(quoteNight(unit, new Date(asOf.getTime() + d * DAY_MS), market, asOf, cfg));
  }
  return out;
}

/** A static description of which rules are active — for surfacing in the UI. */
export function activeRuleSummary(
  cfg: typeof PRICING_RULES = PRICING_RULES,
  gatePct: number = PRICING_AGENT.humanGatePct,
) {
  const sens = SEASONALITY_SENSITIVITY[cfg.seasonality.sensitivity] ?? SEASONALITY_SENSITIVITY.recommended;
  const adjNote = cfg.adjacent.mode === "percent"
    ? `${(cfg.adjacent.value * 100).toFixed(0)}%`
    : `₪${cfg.adjacent.value}`;
  const offNote = cfg.pricingOffset.mode === "percent"
    ? `${(cfg.pricingOffset.value * 100).toFixed(0)}%`
    : `₪${cfg.pricingOffset.value}`;
  return [
    { key: "base", label: "Base rate anchor", enabled: true, note: "per-unit base × factors" },
    { key: "seasonality", label: "Seasonality", enabled: cfg.seasonality.enabled, note: `monthly market curve (${sens.label})` },
    { key: "demand", label: "Demand / events", enabled: cfg.demandEvents.enabled, note: `±${(cfg.demandEvents.cap * 100).toFixed(0)}% cap` },
    { key: "pacing", label: "Booking pace", enabled: cfg.pacing.enabled, note: `±${(cfg.pacing.cap * 100).toFixed(0)}% cap` },
    { key: "occupancy", label: "Occupancy bands", enabled: cfg.occupancy.enabled, note: `${cfg.occupancy.bands.length} bands` },
    { key: "farOut", label: "Far-out premium", enabled: cfg.farOut.enabled, note: cfg.farOut.mode === "marketDriven" ? `market-driven (${cfg.farOut.marketFlavor}) ≥60d, ≤20%` : `${cfg.farOut.mode} >${cfg.farOut.thresholdDays}d` },
    { key: "lastMinute", label: "Last-minute prices", enabled: cfg.lastMinute.enabled, note: cfg.lastMinute.mode === "marketDriven" ? `market-driven (${cfg.lastMinute.marketFlavor}) ≤${Math.min(90, cfg.lastMinute.windowDays)}d` : `${cfg.lastMinute.mode} ≤${Math.min(90, cfg.lastMinute.windowDays)}d` },
    { key: "adjacent", label: "Adjacent factor", enabled: cfg.adjacent.enabled, note: `${adjNote}, ${cfg.adjacent.daysBefore}d before / ${cfg.adjacent.daysAfter}d after bookings` },
    { key: "orphanDay", label: "Orphan day prices", enabled: cfg.orphanDayPrices.enabled, note: `${cfg.orphanDayPrices.ranges.length} gap range(s)` },
    { key: "portfolioOccupancy", label: "Portfolio occupancy", enabled: cfg.portfolioOccupancy.enabled, note: `${cfg.portfolioOccupancy.profile} profile — group occupancy` },
    { key: "dayOfWeek", label: "Day-of-week", enabled: cfg.dayOfWeek.enabled, note: "STR — off for MTR" },
    { key: "los", label: "LOS / monthly discount", enabled: cfg.los.enabled, note: cfg.los.weeklyPct != null || cfg.los.monthlyPct != null ? `scope ${cfg.los.weeklyPct != null ? `wk ${(cfg.los.weeklyPct * 100).toFixed(0)}%` : ""} ${cfg.los.monthlyPct != null ? `mo ${(cfg.los.monthlyPct * 100).toFixed(0)}%` : ""} + quarter` : "per-unit weekly / monthly + quarter" },
    { key: "extraPersonFee", label: "Extra person fee", enabled: cfg.extraPersonFee.enabled, note: `${cfg.extraPersonFee.mode === "percent" ? `${(cfg.extraPersonFee.value * 100).toFixed(0)}%` : `₪${cfg.extraPersonFee.value}`} / extra guest after ${cfg.extraPersonFee.afterGuests}` },
    { key: "checkinCheckout", label: "Check-in/out restriction", enabled: cfg.checkinCheckout.enabled, note: cfg.checkinCheckout.profile ? `profile "${cfg.checkinCheckout.profile}" (not pushed to MiniHotel)` : "no profile attached" },
    { key: "floorCeil", label: "Floor / ceiling clamp", enabled: true, note: "per-unit min/max + advanced min-price rules" },
    { key: "pricingOffset", label: "Pricing offset", enabled: cfg.pricingOffset.enabled, note: `${offNote} post-clamp — may exceed min/max` },
    { key: "minStay", label: "Min-stay hierarchy", enabled: true, note: `${cfg.minStayRules.mode} — lowest-allowed → orphan → DSO → adjacent → far-out → last-minute → default` },
    { key: "gate", label: "Human gate", enabled: true, note: `>±${gatePct}% → Action Center` },
  ];
}
