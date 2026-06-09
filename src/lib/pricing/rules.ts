// The pricing rule set. Each rule is a pure function that, given the context,
// returns a multiplicative factor on the base rate plus a human-readable reason
// (or null when it doesn't apply / is disabled). The engine runs them in order
// and records every applied factor for a full audit trail.

import type { Unit } from "@/lib/repos/units";
import { PRICING_RULES } from "@/lib/config/pricing";
import type { MarketProviders } from "@/lib/pricing/providers";

export interface FactorResult {
  key: string;
  label: string;
  /** Multiplier on the running rate (1.0 = no change). */
  factor: number;
  detail: string;
}

type Rules = typeof PRICING_RULES;

const clampDev = (factor: number, cap: number) => Math.max(1 - cap, Math.min(1 + cap, factor));
const pct = (f: number) => `${f >= 1 ? "+" : ""}${((f - 1) * 100).toFixed(1)}%`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function seasonalityRule(date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.seasonality.enabled) return null;
  const idx = m.seasonalityIndex(date) ?? cfg.seasonality.monthlyIndex[date.getUTCMonth()];
  if (idx === 1) return null;
  return {
    key: "seasonality",
    label: "Seasonality",
    factor: idx,
    detail: `${MONTHS[date.getUTCMonth()]} season ${pct(idx)}`,
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

/** Length-of-stay discount fraction (0..1) for a booking of `nights`, best tier wins. */
export function losDiscountForStay(unit: Unit, nights: number, cfg: Rules = PRICING_RULES): number {
  if (!cfg.los.enabled) return 0;
  if (nights >= cfg.los.quarterlyMinNights) return Math.max(unit.monthlyDiscountPct, cfg.los.quarterlyDiscountPct);
  if (nights >= 30) return unit.monthlyDiscountPct;
  if (nights >= 7) return unit.weeklyDiscountPct;
  return 0;
}
