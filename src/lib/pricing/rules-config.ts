// Operator-editable overrides for the pricing rule engine. Code defaults live in
// PRICING_RULES (src/lib/config/pricing.ts); overrides are stored as JSON in the
// settings store (Settings → Pricing engine rules) and deep-merged at read time.
// Every engine entry point reads effectiveRules(), so a save takes effect on the
// next pricing pass / curve request — no redeploy.

import {
  PRICING_RULES,
  PRICING_AGENT,
  PRICING_OFFSET_LIMITS,
  SEASONALITY_SENSITIVITY,
  type PricingRulesConfig,
  type SeasonalitySensitivity,
} from "@/lib/config/pricing";
import { getSetting, setSetting } from "@/lib/repos/visibility";

const RULES_KEY = "pricing_rule_overrides";

/** Partial, nested subset of PricingRulesConfig plus the agent's human gate. */
export interface RuleOverrides {
  currentRateLeadDays?: number;
  seasonality?: { enabled?: boolean; sensitivity?: SeasonalitySensitivity };
  demandEvents?: { enabled?: boolean; cap?: number };
  pacing?: { enabled?: boolean; sensitivity?: number; cap?: number };
  occupancy?: { enabled?: boolean };
  farOut?: { enabled?: boolean; thresholdDays?: number; cap?: number; rampDays?: number };
  lastMinute?: { enabled?: boolean; windowDays?: number; maxDiscount?: number };
  adjacent?: {
    enabled?: boolean;
    mode?: "percent" | "fixed";
    value?: number;
    daysBefore?: number;
    daysAfter?: number;
    applyOnWeekends?: boolean;
  };
  dayOfWeek?: { enabled?: boolean };
  los?: { enabled?: boolean; quarterlyMinNights?: number; quarterlyDiscountPct?: number };
  pricingOffset?: { enabled?: boolean; mode?: "percent" | "fixed"; value?: number };
  minStayHierarchy?: { farOutThresholdDays?: number; farOutNights?: number };
  humanGatePct?: number;
}

const SECTION_KEYS = [
  "seasonality",
  "demandEvents",
  "pacing",
  "occupancy",
  "farOut",
  "lastMinute",
  "adjacent",
  "dayOfWeek",
  "los",
  "pricingOffset",
  "minStayHierarchy",
] as const;

export function getRuleOverrides(): RuleOverrides {
  const raw = getSetting(RULES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RuleOverrides;
  } catch {
    return {};
  }
}

/** Pure save-style merge: per-section shallow merge of `patch` over `cur`, so a
 *  partial patch doesn't drop other fields. Used by save AND by the Preview
 *  Prices graph (which must show exactly what a Save would produce). */
export function mergeRuleOverrides(cur: RuleOverrides, patch: RuleOverrides): RuleOverrides {
  const next: RuleOverrides = { ...cur, ...patch };
  for (const k of SECTION_KEYS) {
    if (patch[k]) next[k] = { ...(cur[k] as object), ...(patch[k] as object) } as never;
  }
  return next;
}

export function saveRuleOverrides(patch: RuleOverrides): RuleOverrides {
  const next = mergeRuleOverrides(getRuleOverrides(), patch);
  setSetting(RULES_KEY, JSON.stringify(next));
  return next;
}

export function resetRuleOverrides(): void {
  setSetting(RULES_KEY, "");
}

const clampNum = (v: number | undefined, lo: number, hi: number, fallback: number) =>
  v == null || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, v));

/** Code defaults with the given overrides merged on top (sanitized). */
export function rulesWithOverrides(o: RuleOverrides): PricingRulesConfig {
  const d = PRICING_RULES;
  const sens =
    o.seasonality?.sensitivity && o.seasonality.sensitivity in SEASONALITY_SENSITIVITY
      ? o.seasonality.sensitivity
      : d.seasonality.sensitivity;
  const adjacent = { ...d.adjacent, ...o.adjacent };
  adjacent.daysBefore = Math.round(clampNum(adjacent.daysBefore, 0, 30, d.adjacent.daysBefore));
  adjacent.daysAfter = Math.round(clampNum(adjacent.daysAfter, 0, 30, d.adjacent.daysAfter));
  adjacent.value =
    adjacent.mode === "percent"
      ? clampNum(adjacent.value, -0.75, 5, 0) // mirrors the −75%..+500% adjustment range
      : clampNum(adjacent.value, -500, 500, 0);
  const pricingOffset = { ...d.pricingOffset, ...o.pricingOffset };
  const lim = PRICING_OFFSET_LIMITS[pricingOffset.mode === "fixed" ? "fixed" : "percent"];
  pricingOffset.value = clampNum(pricingOffset.value, lim.min, lim.max, 0);
  return {
    currentRateLeadDays: o.currentRateLeadDays ?? d.currentRateLeadDays,
    curveHorizonDays: d.curveHorizonDays,
    seasonality: { ...d.seasonality, ...o.seasonality, sensitivity: sens },
    demandEvents: { ...d.demandEvents, ...o.demandEvents },
    pacing: { ...d.pacing, ...o.pacing },
    occupancy: { ...d.occupancy, ...o.occupancy },
    farOut: { ...d.farOut, ...o.farOut },
    lastMinute: { ...d.lastMinute, ...o.lastMinute },
    adjacent,
    dayOfWeek: { ...d.dayOfWeek, ...o.dayOfWeek },
    los: { ...d.los, ...o.los },
    pricingOffset,
    minStayHierarchy: { ...d.minStayHierarchy, ...o.minStayHierarchy },
  };
}

/** Code defaults with operator overrides merged on top. */
export function effectiveRules(): PricingRulesConfig {
  return rulesWithOverrides(getRuleOverrides());
}

/** The ±% human gate (spec §5), operator-overridable within sane bounds. */
export function effectiveHumanGatePct(): number {
  const o = getRuleOverrides().humanGatePct;
  if (o == null || !Number.isFinite(o)) return PRICING_AGENT.humanGatePct;
  return Math.min(50, Math.max(1, o));
}
