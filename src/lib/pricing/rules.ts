// The pricing rule set. Each rule is a pure function that, given the context,
// returns a multiplicative factor on the base rate plus a human-readable reason
// (or null when it doesn't apply / is disabled). The engine runs them in order
// and records every applied factor for a full audit trail.

import type { Unit } from "@/lib/repos/units";
import {
  PRICING_RULES,
  SEASONALITY_SENSITIVITY,
  PRICING_OFFSET_LIMITS,
} from "@/lib/config/pricing";
import type { MarketProviders } from "@/lib/pricing/providers";

export interface FactorResult {
  key: string;
  label: string;
  /** Multiplier on the running rate (1.0 = no change). */
  factor: number;
  /** Optional ₪ additive (fixed-mode adjustments), applied after all multipliers. */
  add?: number;
  detail: string;
}

type Rules = typeof PRICING_RULES;

const DAY_MS = 86_400_000;
const clampDev = (factor: number, cap: number) => Math.max(1 - cap, Math.min(1 + cap, factor));
const pct = (f: number) => `${f >= 1 ? "+" : ""}${((f - 1) * 100).toFixed(1)}%`;
const shiftDay = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function seasonalityRule(date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.seasonality.enabled) return null;
  const sens =
    SEASONALITY_SENSITIVITY[cfg.seasonality.sensitivity] ?? SEASONALITY_SENSITIVITY.recommended;
  if (sens.amplitude === 0) return null; // "No Seasonality"
  const idx = m.seasonalityIndex(date) ?? cfg.seasonality.monthlyIndex[date.getUTCMonth()];
  const factor = 1 + (idx - 1) * sens.amplitude;
  if (factor === 1) return null;
  const sensTxt =
    cfg.seasonality.sensitivity === "recommended" ? "" : ` (${sens.label.toLowerCase()})`;
  return {
    key: "seasonality",
    label: "Seasonality",
    factor,
    detail: `${MONTHS[date.getUTCMonth()]} season ${pct(factor)}${sensTxt}`,
  };
}

export function demandRule(unit: Unit, date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.demandEvents.enabled) return null;
  const { bump, driver } = m.eventDemand(unit, date);
  const factor = clampDev(1 + bump, cfg.demandEvents.cap);
  if (factor === 1) return null;
  return { key: "demand", label: "Demand/events", factor, detail: `${pct(factor)} — ${driver}` };
}

export function pacingRule(unit: Unit, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.pacing.enabled) return null;
  const pace = m.pacing(unit); // -1..+1
  const factor = clampDev(1 + pace * cfg.pacing.sensitivity, cfg.pacing.cap);
  if (factor === 1) return null;
  const word = pace >= 0 ? "ahead of" : "behind";
  return { key: "pacing", label: "Booking pace", factor, detail: `${pct(factor)} — pacing ${word} norm` };
}

export function occupancyRule(unit: Unit, date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.occupancy.enabled) return null;
  const occ = m.occupancy(unit, date);
  const band = cfg.occupancy.bands.find((b) => occ < b.upTo) ?? cfg.occupancy.bands[cfg.occupancy.bands.length - 1];
  if (band.adjust === 0) return null;
  return {
    key: "occupancy",
    label: "Occupancy",
    factor: 1 + band.adjust,
    detail: `${(occ * 100).toFixed(0)}% (${band.label}) ${pct(1 + band.adjust)}`,
  };
}

export function farOutRule(leadDays: number, cfg: Rules): FactorResult | null {
  if (!cfg.farOut.enabled || leadDays <= cfg.farOut.thresholdDays) return null;
  const ramp = Math.min(1, (leadDays - cfg.farOut.thresholdDays) / cfg.farOut.rampDays);
  const factor = 1 + ramp * cfg.farOut.cap;
  if (factor === 1) return null;
  return { key: "farOut", label: "Far-out premium", factor, detail: `${leadDays}d out ${pct(factor)}` };
}

export function lastMinuteRule(leadDays: number, cfg: Rules): FactorResult | null {
  if (!cfg.lastMinute.enabled || leadDays > cfg.lastMinute.windowDays) return null;
  const closeness = (cfg.lastMinute.windowDays - leadDays) / cfg.lastMinute.windowDays;
  const factor = 1 - closeness * cfg.lastMinute.maxDiscount;
  if (factor === 1) return null;
  return { key: "lastMinute", label: "Last-minute", factor, detail: `${leadDays}d out ${pct(factor)}` };
}

export function dayOfWeekRule(date: Date, cfg: Rules): FactorResult | null {
  if (!cfg.dayOfWeek.enabled) return null;
  const factor = cfg.dayOfWeek.multiplier[date.getUTCDay()];
  if (factor === 1) return null;
  return { key: "dayOfWeek", label: "Day-of-week", factor, detail: pct(factor) };
}

/** PriceLabs "Adjacent Factor": adjust the open days right before/after a
 *  booking — a discount fills the gap, a premium discourages back-to-back
 *  turnovers. Skips weekends (Fri/Sat here) unless opted in, and never fires on
 *  the booked night itself. Stacks with last-minute (and orphan-day, when it
 *  lands) via resolveAdjustmentStack. */
export function adjacentRule(
  unit: Unit,
  date: Date,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.adjacent;
  if (!c.enabled || c.value === 0 || (c.daysBefore <= 0 && c.daysAfter <= 0)) return null;
  if (m.isBooked(unit, date)) return null; // the adjustment targets the open neighbors
  const dow = date.getUTCDay();
  if (!c.applyOnWeekends && (dow === 5 || dow === 6)) return null;

  let near: "after" | "before" | null = null;
  for (let k = 1; k <= c.daysAfter && !near; k++) {
    if (m.isBooked(unit, shiftDay(date, -k))) near = "after";
  }
  for (let k = 1; k <= c.daysBefore && !near; k++) {
    if (m.isBooked(unit, shiftDay(date, k))) near = "before";
  }
  if (!near) return null;

  const word = c.value < 0 ? "discount" : "premium";
  if (c.mode === "fixed") {
    return {
      key: "adjacent",
      label: "Adjacent factor",
      factor: 1,
      add: c.value,
      detail: `₪${Math.abs(c.value)} ${word} — ${near} a booking`,
    };
  }
  return {
    key: "adjacent",
    label: "Adjacent factor",
    factor: 1 + c.value,
    detail: `${pct(1 + c.value)} — ${near} a booking`,
  };
}

/** PriceLabs stacking for the gap/lead-time adjustment class (last-minute,
 *  adjacent factor, and orphan-day when it lands): among discounts only the
 *  LARGEST applies; premiums all stack; a mix applies the largest discount plus
 *  every premium. Fixed (₪) entries are compared as a fraction of `reference`
 *  (the unit's base rate). */
export function resolveAdjustmentStack(
  candidates: (FactorResult | null)[],
  reference: number,
): FactorResult[] {
  const applied = candidates.filter((c): c is FactorResult => c !== null);
  if (applied.length <= 1) return applied;
  const depth = (c: FactorResult) => c.factor - 1 + (c.add ? c.add / Math.max(1, reference) : 0);
  const discounts = applied.filter((c) => depth(c) < 0);
  const premiums = applied.filter((c) => depth(c) >= 0);
  if (discounts.length <= 1) return [...discounts, ...premiums];
  let deepest = discounts.reduce((a, b) => (depth(b) < depth(a) ? b : a));
  deepest = { ...deepest, detail: `${deepest.detail} (largest of ${discounts.length} discounts)` };
  return [deepest, ...premiums];
}

/** PriceLabs "Pricing Offset": a final fixed/percent nudge applied AFTER all
 *  other customizations — including the min/max clamp and fixed-price overrides
 *  — so the result may legitimately sit outside the unit's floor/ceiling.
 *  Returns the adjusted rate plus an audit-trail entry. */
export function pricingOffsetRule(
  rate: number,
  cfg: Rules,
): { rate: number; entry: FactorResult } | null {
  const c = cfg.pricingOffset;
  if (!c.enabled || c.value === 0) return null;
  const lim = PRICING_OFFSET_LIMITS[c.mode];
  const v = Math.max(lim.min, Math.min(lim.max, c.value));
  const next = c.mode === "percent" ? rate * (1 + v) : rate + v;
  if (next === rate) return null;
  return {
    rate: next,
    entry: {
      key: "pricingOffset",
      label: "Pricing offset",
      factor: rate > 0 ? next / rate : 1,
      detail: `${c.mode === "percent" ? pct(1 + v) : `₪${v > 0 ? "+" : ""}${v}`} — applied after min/max`,
    },
  };
}

/** Length-of-stay discount fraction (0..1) for a booking of `nights`, best tier wins. */
export function losDiscountForStay(unit: Unit, nights: number, cfg: Rules = PRICING_RULES): number {
  if (!cfg.los.enabled) return 0;
  if (nights >= cfg.los.quarterlyMinNights) return Math.max(unit.monthlyDiscountPct, cfg.los.quarterlyDiscountPct);
  if (nights >= 30) return unit.monthlyDiscountPct;
  if (nights >= 7) return unit.weeklyDiscountPct;
  return 0;
}
