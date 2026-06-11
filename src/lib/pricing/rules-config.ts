// Operator-editable overrides for the pricing rule engine, SCOPED the PriceLabs
// way: account-wide, per group customization (attachable to listings as group
// or sub-group), and per listing. Code defaults live in PRICING_RULES
// (src/lib/config/pricing.ts); each scope stores a JSON overrides blob in the
// settings store. Resolution for a unit is per-SECTION, most specific scope
// wins WHOLESALE (listing > sub-group > group > account) — PriceLabs's
// "minimum-night settings are all or nothing; rules from different levels
// cannot combine". Every engine entry point reads effectiveRulesForUnit(), so a
// save takes effect on the next pricing pass / curve request — no redeploy.

import {
  PRICING_RULES,
  PRICING_AGENT,
  PRICING_OFFSET_LIMITS,
  PORTFOLIO_OBA_PRESETS,
  SEASONALITY_SENSITIVITY,
  MARKET_FLAVOR_MULT,
  type PricingRulesConfig,
  type SeasonalitySensitivity,
  type MinPriceMode,
  type MarketFlavor,
  type PortfolioObaWindow,
} from "@/lib/config/pricing";
import type { Unit } from "@/lib/repos/units";
import { findCicoProfile } from "@/lib/repos/profiles";
import { getSetting, setSetting } from "@/lib/repos/visibility";

const RULES_KEY = "pricing_rule_overrides";

/** Scope string: "account" | "group:<name>" | "unit:<id>". A group scope is one
 *  group customization — the same blob applies whether a listing attaches it as
 *  its group or its sub-group. */
export type RuleScope = string;

export function scopeStoreKey(scope: RuleScope): string {
  if (!scope || scope === "account") return RULES_KEY;
  if (scope.startsWith("group:") && scope.length > 6) return `${RULES_KEY}:${scope}`;
  if (scope.startsWith("unit:") && scope.length > 5) return `${RULES_KEY}:${scope}`;
  throw new Error(`bad rule scope: ${scope}`);
}

/** Partial, nested subset of PricingRulesConfig plus the agent's human gate. */
export interface RuleOverrides {
  currentRateLeadDays?: number;
  seasonality?: { enabled?: boolean; sensitivity?: SeasonalitySensitivity };
  demandEvents?: { enabled?: boolean; cap?: number };
  pacing?: { enabled?: boolean; sensitivity?: number; cap?: number };
  occupancy?: { enabled?: boolean };
  farOut?: {
    enabled?: boolean;
    mode?: "gradual" | "flat" | "marketDriven";
    marketFlavor?: MarketFlavor;
    thresholdDays?: number;
    cap?: number;
    rampDays?: number;
  };
  lastMinute?: {
    enabled?: boolean;
    mode?: "gradual" | "flat" | "fixed" | "marketDriven";
    marketFlavor?: MarketFlavor;
    windowDays?: number;
    value?: number;
    /** Legacy field (pre mode-split): positive discount depth for the gradual ramp. */
    maxDiscount?: number;
  };
  adjacent?: {
    enabled?: boolean;
    mode?: "percent" | "fixed";
    value?: number;
    daysBefore?: number;
    daysAfter?: number;
    applyOnWeekends?: boolean;
  };
  dayOfWeek?: { enabled?: boolean };
  los?: {
    enabled?: boolean;
    weeklyPct?: number | null;
    monthlyPct?: number | null;
    quarterlyMinNights?: number;
    quarterlyDiscountPct?: number;
  };
  extraPersonFee?: {
    enabled?: boolean;
    mode?: "fixed" | "percent";
    value?: number;
    afterGuests?: number;
  };
  checkinCheckout?: { enabled?: boolean; profile?: string | null };
  pricingOffset?: { enabled?: boolean; mode?: "percent" | "fixed"; value?: number };
  weekend?: { days?: number[] };
  orphanDayPrices?: {
    enabled?: boolean;
    ranges?: Array<{
      upToGapNights: number;
      mode: "percent" | "fixed";
      weekday: number;
      weekend: number;
      withinDays: number | null;
    }>;
  };
  portfolioOccupancy?: {
    enabled?: boolean;
    profile?: "short" | "medium" | "long" | "custom";
    windows?: PortfolioObaWindow[];
  };
  minPrices?: {
    farOut?: { enabled?: boolean; beyondDays?: number; mode?: MinPriceMode; value?: number };
    weekend?: { enabled?: boolean; mode?: MinPriceMode; value?: number };
    lastMinute?: { enabled?: boolean; withinDays?: number; mode?: MinPriceMode; value?: number };
    orphan?: { enabled?: boolean; mode?: MinPriceMode; value?: number };
  };
  minStayRules?: {
    mode?: "recommended" | "custom";
    highestAllowed?: number;
    custom?: { rule?: "fixed" | "bookingValue"; weekday?: number; weekend?: number; bookingValue?: number };
    lastMinute?: Array<{ withinDays: number; weekday: number; weekend: number }>;
    adjacent?: { enabled?: boolean; afterNights?: number; beforeFlushFit?: boolean };
    orphanGap?: {
      enabled?: boolean;
      strategy?: "lengthOfGap" | "gapMinus1" | "gapMinus2" | "fixed";
      fixedNights?: number;
      maxGapNights?: number;
      lowestAllowed?: number;
    };
    adaptiveOccupancy?: { enabled?: boolean };
  };
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
  "extraPersonFee",
  "checkinCheckout",
  "pricingOffset",
  "weekend",
  "orphanDayPrices",
  "portfolioOccupancy",
  "minPrices",
  "minStayRules",
  "minStayHierarchy",
] as const;

export function getRuleOverrides(scope: RuleScope = "account"): RuleOverrides {
  const raw = getSetting(scopeStoreKey(scope));
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

export function saveRuleOverrides(patch: RuleOverrides, scope: RuleScope = "account"): RuleOverrides {
  const next = mergeRuleOverrides(getRuleOverrides(scope), patch);
  setSetting(scopeStoreKey(scope), JSON.stringify(next));
  return next;
}

export function resetRuleOverrides(scope: RuleScope = "account"): void {
  setSetting(scopeStoreKey(scope), "");
}

/** Per-section resolution down a scope chain (account → group → sub-group →
 *  listing): a more specific scope that defines a section REPLACES it outright.
 *  Top-level scalars (lead days, human gate) stay account-level — the Action
 *  Center gate is a spec-level control, not a per-listing preference. */
function resolveChain(chain: RuleOverrides[]): RuleOverrides {
  const out: RuleOverrides = {};
  for (const o of chain) {
    for (const k of SECTION_KEYS) {
      if (o[k] !== undefined) out[k] = o[k] as never;
    }
  }
  out.currentRateLeadDays = chain[0]?.currentRateLeadDays;
  out.humanGatePct = chain[0]?.humanGatePct;
  return out;
}

function chainFor(unit: Pick<Unit, "id" | "group" | "subgroup">): RuleOverrides[] {
  const chain: RuleOverrides[] = [getRuleOverrides("account")];
  if (unit.group) chain.push(getRuleOverrides(`group:${unit.group}`));
  if (unit.subgroup) chain.push(getRuleOverrides(`group:${unit.subgroup}`));
  chain.push(getRuleOverrides(`unit:${unit.id}`));
  return chain;
}

const clampNum = (v: number | undefined, lo: number, hi: number, fallback: number) =>
  v == null || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, v));
const clampInt = (v: number | undefined, lo: number, hi: number, fallback: number) =>
  Math.round(clampNum(v, lo, hi, fallback));

/** Code defaults with the given overrides merged on top (sanitized). */
export function rulesWithOverrides(o: RuleOverrides): PricingRulesConfig {
  const d = PRICING_RULES;
  const sens =
    o.seasonality?.sensitivity && o.seasonality.sensitivity in SEASONALITY_SENSITIVITY
      ? o.seasonality.sensitivity
      : d.seasonality.sensitivity;

  const adjacent = { ...d.adjacent, ...o.adjacent };
  adjacent.daysBefore = clampInt(adjacent.daysBefore, 0, 30, d.adjacent.daysBefore);
  adjacent.daysAfter = clampInt(adjacent.daysAfter, 0, 30, d.adjacent.daysAfter);
  adjacent.value =
    adjacent.mode === "percent"
      ? clampNum(adjacent.value, -0.75, 5, 0) // mirrors the −75%..+500% adjustment range
      : clampNum(adjacent.value, -500, 500, 0);

  const pricingOffset = { ...d.pricingOffset, ...o.pricingOffset };
  const lim = PRICING_OFFSET_LIMITS[pricingOffset.mode === "fixed" ? "fixed" : "percent"];
  pricingOffset.value = clampNum(pricingOffset.value, lim.min, lim.max, 0);

  const validFlavor = (x: MarketFlavor | undefined, fb: MarketFlavor): MarketFlavor =>
    x && x in MARKET_FLAVOR_MULT ? x : fb;
  const farOut = { ...d.farOut, ...o.farOut };
  farOut.mode = (["gradual", "flat", "marketDriven"] as const).includes(farOut.mode)
    ? farOut.mode
    : d.farOut.mode;
  farOut.marketFlavor = validFlavor(farOut.marketFlavor, d.farOut.marketFlavor);
  farOut.thresholdDays = clampInt(farOut.thresholdDays, 0, 730, d.farOut.thresholdDays);
  farOut.cap = clampNum(farOut.cap, -0.75, 5, d.farOut.cap);
  farOut.rampDays = clampInt(farOut.rampDays, 1, 730, d.farOut.rampDays);

  const lmo = o.lastMinute;
  const lastMinute = { ...d.lastMinute, ...lmo };
  lastMinute.mode = (["gradual", "flat", "fixed", "marketDriven"] as const).includes(lastMinute.mode)
    ? lastMinute.mode
    : d.lastMinute.mode;
  lastMinute.marketFlavor = validFlavor(lastMinute.marketFlavor, d.lastMinute.marketFlavor);
  lastMinute.windowDays = clampInt(lastMinute.windowDays, 1, 90, d.lastMinute.windowDays);
  // Legacy override blobs carried `maxDiscount` (a positive gradual depth).
  if (lmo && lmo.value === undefined && lmo.maxDiscount != null && Number.isFinite(lmo.maxDiscount)) {
    lastMinute.value = -Math.abs(lmo.maxDiscount);
  }
  lastMinute.value =
    lastMinute.mode === "fixed"
      ? clampNum(lastMinute.value, 0, 1000000, 0)
      : clampNum(lastMinute.value, -0.75, 5, d.lastMinute.value);

  const weekendDays = (o.weekend?.days ?? d.weekend.days)
    .map((x) => Math.round(x))
    .filter((x) => x >= 0 && x <= 6);
  const weekend = { days: weekendDays.length ? [...new Set(weekendDays)] : d.weekend.days };

  const orphanRanges = (o.orphanDayPrices?.ranges ?? d.orphanDayPrices.ranges)
    .filter((r) => r && Number.isFinite(r.upToGapNights) && r.upToGapNights >= 1)
    .slice(0, 5)
    .map((r) => ({
      upToGapNights: clampInt(r.upToGapNights, 1, 30, 2),
      mode: r.mode === "fixed" ? ("fixed" as const) : ("percent" as const),
      weekday: r.mode === "fixed" ? clampNum(r.weekday, 0, 100000, 0) : clampNum(r.weekday, -0.75, 5, 0),
      weekend: r.mode === "fixed" ? clampNum(r.weekend, 0, 100000, 0) : clampNum(r.weekend, -0.75, 5, 0),
      withinDays:
        r.withinDays == null || !Number.isFinite(r.withinDays) || r.withinDays <= 0
          ? null
          : Math.round(r.withinDays),
    }))
    .sort((a, b) => a.upToGapNights - b.upToGapNights); // ascending-order rule
  const orphanDayPrices = {
    enabled: o.orphanDayPrices?.enabled ?? d.orphanDayPrices.enabled,
    ranges: orphanRanges,
  };

  const profile = o.portfolioOccupancy?.profile ?? d.portfolioOccupancy.profile;
  const rawWindows =
    profile === "custom"
      ? (o.portfolioOccupancy?.windows ?? d.portfolioOccupancy.windows)
      : PORTFOLIO_OBA_PRESETS[profile in PORTFOLIO_OBA_PRESETS ? (profile as "short" | "medium" | "long") : "long"];
  const portfolioOccupancy = {
    enabled: o.portfolioOccupancy?.enabled ?? d.portfolioOccupancy.enabled,
    profile,
    windows: rawWindows
      .slice(0, 5)
      .map((w) => ({
        uptoDays: clampInt(w.uptoDays, 1, 9999, 9999),
        bands: w.bands.map((b) => ({ ...b, adjust: clampNum(b.adjust, -0.5, 5, 0) })),
      }))
      .sort((a, b) => a.uptoDays - b.uptoDays),
  };

  const mp = (
    base: { enabled: boolean; mode: MinPriceMode; value: number },
    over?: { enabled?: boolean; mode?: MinPriceMode; value?: number },
  ) => {
    const m = { ...base, ...over };
    m.value = m.mode === "fixed" ? clampNum(m.value, 0, 1000000, 0) : clampNum(m.value, -0.9, 5, 0);
    return m;
  };
  const minPrices = {
    farOut: {
      ...mp(d.minPrices.farOut, o.minPrices?.farOut),
      beyondDays: clampInt(o.minPrices?.farOut?.beyondDays, 1, 730, d.minPrices.farOut.beyondDays),
    },
    weekend: mp(d.minPrices.weekend, o.minPrices?.weekend),
    lastMinute: {
      ...mp(d.minPrices.lastMinute, o.minPrices?.lastMinute),
      withinDays: clampInt(o.minPrices?.lastMinute?.withinDays, 1, 365, d.minPrices.lastMinute.withinDays),
    },
    orphan: mp(d.minPrices.orphan, o.minPrices?.orphan),
  };

  const los = { ...d.los, ...o.los };
  // PriceLabs range: 0–75%, entered without a sign. null = use the unit's own.
  los.weeklyPct = los.weeklyPct != null ? clampNum(Math.abs(los.weeklyPct), 0, 0.75, 0) : null;
  los.monthlyPct = los.monthlyPct != null ? clampNum(Math.abs(los.monthlyPct), 0, 0.75, 0) : null;
  los.quarterlyDiscountPct = clampNum(los.quarterlyDiscountPct, 0, 0.75, d.los.quarterlyDiscountPct);

  const epf = { ...d.extraPersonFee, ...o.extraPersonFee };
  epf.mode = epf.mode === "percent" ? "percent" : "fixed";
  epf.value = epf.mode === "percent" ? clampNum(epf.value, 0, 1, 0) : clampNum(epf.value, 0, 100000, 0);
  epf.afterGuests = clampInt(epf.afterGuests, 1, 20, d.extraPersonFee.afterGuests);

  // Resolve the attached CICO profile's day lists at read time (all days when
  // no profile / unknown profile). Archived profiles keep applying (PriceLabs).
  const cco = { enabled: o.checkinCheckout?.enabled ?? d.checkinCheckout.enabled, profile: o.checkinCheckout?.profile ?? d.checkinCheckout.profile };
  const cicoProf = findCicoProfile(cco.profile);
  const checkinCheckout = {
    enabled: cco.enabled,
    profile: cco.profile,
    allowedCheckin: cicoProf?.allowedCheckin ?? d.checkinCheckout.allowedCheckin,
    allowedCheckout: cicoProf?.allowedCheckout ?? d.checkinCheckout.allowedCheckout,
  };

  const ms = o.minStayRules;
  const minStayRules: PricingRulesConfig["minStayRules"] = {
    mode: ms?.mode === "custom" ? "custom" : "recommended",
    highestAllowed: clampInt(ms?.highestAllowed, 1, 365, d.minStayRules.highestAllowed),
    custom: {
      rule: ms?.custom?.rule === "bookingValue" ? "bookingValue" : "fixed",
      weekday: clampInt(ms?.custom?.weekday, 1, 365, d.minStayRules.custom.weekday),
      weekend: clampInt(ms?.custom?.weekend, 1, 365, d.minStayRules.custom.weekend),
      bookingValue: clampNum(ms?.custom?.bookingValue, 0, 10000000, d.minStayRules.custom.bookingValue),
    },
    lastMinute: (ms?.lastMinute ?? d.minStayRules.lastMinute)
      .filter((x) => x && Number.isFinite(x.withinDays) && x.withinDays > 0)
      .slice(0, 3)
      .map((x) => ({
        withinDays: clampInt(x.withinDays, 1, 365, 7),
        weekday: clampInt(x.weekday, 1, 365, 1),
        weekend: clampInt(x.weekend, 1, 365, 1),
      })),
    adjacent: {
      enabled: ms?.adjacent?.enabled ?? d.minStayRules.adjacent.enabled,
      afterNights: clampInt(ms?.adjacent?.afterNights, 1, 365, d.minStayRules.adjacent.afterNights),
      beforeFlushFit: ms?.adjacent?.beforeFlushFit ?? d.minStayRules.adjacent.beforeFlushFit,
    },
    orphanGap: {
      enabled: ms?.orphanGap?.enabled ?? d.minStayRules.orphanGap.enabled,
      strategy: (["lengthOfGap", "gapMinus1", "gapMinus2", "fixed"] as const).includes(
        ms?.orphanGap?.strategy as never,
      )
        ? (ms!.orphanGap!.strategy as PricingRulesConfig["minStayRules"]["orphanGap"]["strategy"])
        : d.minStayRules.orphanGap.strategy,
      fixedNights: clampInt(ms?.orphanGap?.fixedNights, 1, 365, d.minStayRules.orphanGap.fixedNights),
      maxGapNights: clampInt(ms?.orphanGap?.maxGapNights, 1, 30, d.minStayRules.orphanGap.maxGapNights),
      lowestAllowed: clampInt(ms?.orphanGap?.lowestAllowed, 1, 365, d.minStayRules.orphanGap.lowestAllowed),
    },
    adaptiveOccupancy: {
      enabled: ms?.adaptiveOccupancy?.enabled ?? d.minStayRules.adaptiveOccupancy.enabled,
    },
  };

  return {
    currentRateLeadDays: o.currentRateLeadDays ?? d.currentRateLeadDays,
    curveHorizonDays: d.curveHorizonDays,
    seasonality: { ...d.seasonality, ...o.seasonality, sensitivity: sens },
    demandEvents: { ...d.demandEvents, ...o.demandEvents },
    pacing: { ...d.pacing, ...o.pacing },
    occupancy: { ...d.occupancy, ...o.occupancy },
    farOut,
    lastMinute: {
      enabled: lastMinute.enabled,
      mode: lastMinute.mode,
      marketFlavor: lastMinute.marketFlavor,
      windowDays: lastMinute.windowDays,
      value: lastMinute.value,
    },
    adjacent,
    dayOfWeek: { ...d.dayOfWeek, ...o.dayOfWeek },
    los,
    extraPersonFee: epf,
    checkinCheckout,
    pricingOffset,
    weekend,
    orphanDayPrices,
    portfolioOccupancy,
    minPrices,
    minStayRules,
    minStayHierarchy: { ...d.minStayHierarchy, ...o.minStayHierarchy },
  };
}

/** Account-level effective rules (contexts with no unit at hand). */
export function effectiveRules(): PricingRulesConfig {
  return rulesWithOverrides(getRuleOverrides("account"));
}

/** Effective rules for one unit through the full scope chain. */
export function effectiveRulesForUnit(unit: Pick<Unit, "id" | "group" | "subgroup">): PricingRulesConfig {
  return rulesWithOverrides(resolveChain(chainFor(unit)));
}

/** Effective rules for a unit AS IF `patch` were saved at `scope` — powers the
 *  Preview Prices graph. If the scope isn't in the unit's chain (previewing a
 *  group the listing doesn't belong to), the patch honestly has no effect. */
export function effectiveRulesForUnitWithPatch(
  unit: Pick<Unit, "id" | "group" | "subgroup">,
  scope: RuleScope,
  patch: RuleOverrides,
): PricingRulesConfig {
  const scopes: RuleScope[] = ["account"];
  if (unit.group) scopes.push(`group:${unit.group}`);
  if (unit.subgroup) scopes.push(`group:${unit.subgroup}`);
  scopes.push(`unit:${unit.id}`);
  const chain = scopes.map((s) =>
    s === (scope || "account")
      ? mergeRuleOverrides(getRuleOverrides(s), patch)
      : getRuleOverrides(s),
  );
  return rulesWithOverrides(resolveChain(chain));
}

/** The ±% human gate (spec §5), operator-overridable within sane bounds. */
export function effectiveHumanGatePct(): number {
  const o = getRuleOverrides("account").humanGatePct;
  if (o == null || !Number.isFinite(o)) return PRICING_AGENT.humanGatePct;
  return Math.min(50, Math.max(1, o));
}
