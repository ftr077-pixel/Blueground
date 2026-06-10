// Operator-editable overrides for the pricing rule engine. Code defaults live in
// PRICING_RULES (src/lib/config/pricing.ts); overrides are stored as JSON in the
// settings store (Settings → Pricing engine rules) and deep-merged at read time.
// Every engine entry point reads effectiveRules(), so a save takes effect on the
// next pricing pass / curve request — no redeploy.

import {
  PRICING_RULES,
  PRICING_AGENT,
  type PricingRulesConfig,
} from "@/lib/config/pricing";
import { getSetting, setSetting } from "@/lib/repos/visibility";

const RULES_KEY = "pricing_rule_overrides";

/** Partial, nested subset of PricingRulesConfig plus the agent's human gate. */
export interface RuleOverrides {
  currentRateLeadDays?: number;
  seasonality?: { enabled?: boolean };
  demandEvents?: { enabled?: boolean; cap?: number };
  pacing?: { enabled?: boolean; sensitivity?: number; cap?: number };
  occupancy?: { enabled?: boolean };
  farOut?: { enabled?: boolean; thresholdDays?: number; cap?: number; rampDays?: number };
  lastMinute?: { enabled?: boolean; windowDays?: number; maxDiscount?: number };
  dayOfWeek?: { enabled?: boolean };
  los?: { enabled?: boolean; quarterlyMinNights?: number; quarterlyDiscountPct?: number };
  minStayHierarchy?: { farOutThresholdDays?: number; farOutNights?: number };
  humanGatePct?: number;
}

export function getRuleOverrides(): RuleOverrides {
  const raw = getSetting(RULES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RuleOverrides;
  } catch {
    return {};
  }
}

export function saveRuleOverrides(patch: RuleOverrides): RuleOverrides {
  const cur = getRuleOverrides();
  // Shallow-merge per rule section so a partial patch doesn't drop other fields.
  const next: RuleOverrides = { ...cur, ...patch };
  for (const k of [
    "seasonality",
    "demandEvents",
    "pacing",
    "occupancy",
    "farOut",
    "lastMinute",
    "dayOfWeek",
    "los",
    "minStayHierarchy",
  ] as const) {
    if (patch[k]) next[k] = { ...(cur[k] as object), ...(patch[k] as object) } as never;
  }
  setSetting(RULES_KEY, JSON.stringify(next));
  return next;
}

export function resetRuleOverrides(): void {
  setSetting(RULES_KEY, "");
}

/** Code defaults with operator overrides merged on top. */
export function effectiveRules(): PricingRulesConfig {
  const o = getRuleOverrides();
  const d = PRICING_RULES;
  return {
    currentRateLeadDays: o.currentRateLeadDays ?? d.currentRateLeadDays,
    curveHorizonDays: d.curveHorizonDays,
    seasonality: { ...d.seasonality, ...o.seasonality },
    demandEvents: { ...d.demandEvents, ...o.demandEvents },
    pacing: { ...d.pacing, ...o.pacing },
    occupancy: { ...d.occupancy, ...o.occupancy },
    farOut: { ...d.farOut, ...o.farOut },
    lastMinute: { ...d.lastMinute, ...o.lastMinute },
    dayOfWeek: { ...d.dayOfWeek, ...o.dayOfWeek },
    los: { ...d.los, ...o.los },
    minStayHierarchy: { ...d.minStayHierarchy, ...o.minStayHierarchy },
  };
}

/** The ±% human gate (spec §5), operator-overridable within sane bounds. */
export function effectiveHumanGatePct(): number {
  const o = getRuleOverrides().humanGatePct;
  if (o == null || !Number.isFinite(o)) return PRICING_AGENT.humanGatePct;
  return Math.min(50, Math.max(1, o));
}
