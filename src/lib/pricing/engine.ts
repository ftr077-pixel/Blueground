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
  farOutRule,
  lastMinuteRule,
  adjacentRule,
  resolveAdjustmentStack,
  pricingOffsetRule,
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
  minStay: number;
  minStaySource: string;
  /** Effective monthly rate (₪) for a 30-night booking after LOS discount. */
  effectiveMonthlyRate: number;
}

function leadDaysFrom(asOf: Date, date: Date): number {
  return Math.max(0, Math.round((date.getTime() - asOf.getTime()) / DAY_MS));
}

function resolveMinStay(
  unit: Unit,
  date: Date,
  leadDays: number,
  market: MarketProviders,
  cfg: typeof PRICING_RULES,
): { minStay: number; source: string } {
  const floor = unit.lowestMinStay;
  const tiers = PRICING_AGENT.minStayDemandTiers;
  let rec = floor;
  let source = `floor ${floor}n`;

  // Demand-flex default
  const demand = market.eventDemand(unit, date).bump;
  for (const tier of tiers) {
    if (demand >= tier.threshold) {
      rec = floor + tier.bump;
      source = tier.label;
      break;
    }
  }
  // Benchmark against the competitor median
  const median = market.compMedianMinNights();
  if (median && median > rec) {
    rec = Math.min(median, floor + tiers[0].bump);
    source = `market median ${median}n`;
  }
  // Far-out bookings require longer commitments
  if (leadDays > cfg.minStayHierarchy.farOutThresholdDays && cfg.minStayHierarchy.farOutNights > rec) {
    rec = cfg.minStayHierarchy.farOutNights;
    source = "far-out";
  }
  rec = Math.max(floor, Math.min(rec, PRICING_AGENT.maxMinStay));
  // Operator date override wins outright — applied after the floor clamp on
  // purpose, so it can go below the unit floor (e.g. a short gap-fill between
  // two long bookings). Only the global cap still applies.
  const ov = market.dateOverride(unit, date);
  if (ov?.minStay != null) {
    rec = Math.max(1, Math.min(ov.minStay, PRICING_AGENT.maxMinStay));
    source = "override";
  }
  return { minStay: rec, source };
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
  add(farOutRule(leadDays, cfg));
  // Gap/lead-time adjustment class — PriceLabs stacking: largest discount wins,
  // premiums stack, a mix applies largest discount + every premium.
  for (const f of resolveAdjustmentStack(
    [lastMinuteRule(leadDays, cfg), adjacentRule(unit, date, market, cfg)],
    unit.baseRate,
  )) {
    factors.push(f);
  }
  add(dayOfWeekRule(date, cfg));

  // Multiplicative factors compound on the base; fixed (₪) adjustments from
  // fixed-mode rules are added after, before the floor/ceiling clamp.
  const mult = factors.reduce((acc, f) => acc * f.factor, unit.baseRate);
  const fixedAdj = factors.reduce((acc, f) => acc + (f.add ?? 0), 0);
  const rawRate = roundRate(Math.max(0, mult + fixedAdj));

  let rate = rawRate;
  let bound: DateQuote["bound"] = null;
  if (rate < unit.minRate) {
    rate = unit.minRate;
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

  const { minStay, source } = resolveMinStay(unit, date, leadDays, market, cfg);
  const effectiveMonthlyRate = Math.round(rate * 30 * (1 - losDiscountForStay(unit, 30, cfg)));

  return {
    date: date.toISOString().slice(0, 10),
    leadDays,
    base: unit.baseRate,
    factors,
    rawRate,
    rate,
    bound,
    minStay,
    minStaySource: source,
    effectiveMonthlyRate,
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
    { key: "farOut", label: "Far-out premium", enabled: cfg.farOut.enabled, note: `>${cfg.farOut.thresholdDays}d` },
    { key: "lastMinute", label: "Last-minute discount", enabled: cfg.lastMinute.enabled, note: "STR — off for MTR" },
    { key: "adjacent", label: "Adjacent factor", enabled: cfg.adjacent.enabled, note: `${adjNote}, ${cfg.adjacent.daysBefore}d before / ${cfg.adjacent.daysAfter}d after bookings` },
    { key: "dayOfWeek", label: "Day-of-week", enabled: cfg.dayOfWeek.enabled, note: "STR — off for MTR" },
    { key: "los", label: "LOS / monthly discount", enabled: cfg.los.enabled, note: "weekly / monthly / quarter" },
    { key: "floorCeil", label: "Floor / ceiling clamp", enabled: true, note: "per-unit min/max" },
    { key: "pricingOffset", label: "Pricing offset", enabled: cfg.pricingOffset.enabled, note: `${offNote} post-clamp — may exceed min/max` },
    { key: "minStay", label: "Min-stay hierarchy", enabled: true, note: "floor → demand → market → far-out → override" },
    { key: "gate", label: "Human gate", enabled: true, note: `>±${gatePct}% → Action Center` },
  ];
}
