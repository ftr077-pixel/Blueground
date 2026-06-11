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
import {
  findCicoProfile,
  findMinStayProfile,
  findObaProfile,
  findPricingProfile,
  findSeasonalProfile,
} from "@/lib/repos/profiles";
import { OBA_PRESETS } from "@/lib/config/pricing";
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
  demandEvents?: { enabled?: boolean; sensitivity?: SeasonalitySensitivity; cap?: number };
  pacing?: { enabled?: boolean; sensitivity?: number; cap?: number };
  occupancy?: {
    enabled?: boolean;
    profile?: PricingRulesConfig["occupancy"]["profile"];
    customName?: string | null;
    windows?: PortfolioObaWindow[];
  };
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
    tiers?: Array<{ minNights: number; pct: number; minPrice: number | null; maxPrice: number | null }>;
  };
  extraPersonFee?: {
    enabled?: boolean;
    mode?: "fixed" | "percent";
    value?: number;
    afterGuests?: number;
  };
  checkinCheckout?: {
    enabled?: boolean;
    profile?: string | null;
    allowedCheckin?: number[];
    allowedCheckout?: number[];
    lastMinute?: Array<{ withinDays: number; checkin: number[]; checkout: number[] }>;
    smart?: {
      blockGapCreating?: boolean;
      maxGapNights?: number;
      beyondDays?: number;
      allowAdjacent?: boolean;
    };
  };
  rounding?: { enabled?: boolean; digits?: number; endings?: number[] };
  smoothing?: { enabled?: boolean; mode?: "week" | "split"; weekStart?: number };
  freezeUnavailable?: { enabled?: boolean };
  neighborhoodProfile?: { source?: string | null };
  bookingRecency?: { enabled?: boolean };
  seasonalProfile?: { enabled?: boolean; profile?: string | null };
  pricingOffset?: { enabled?: boolean; mode?: "percent" | "fixed"; value?: number };
  weekend?: { days?: number[] };
  orphanDayPrices?: {
    enabled?: boolean;
    ranges?: Array<{
      fromGapNights?: number;
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
  safetyMinPrice?: { enabled?: boolean; pctOfLastYear?: number };
  minStayRules?: {
    profile?: string | null;
    mode?: "recommended" | "custom";
    recommendedFlavor?: "str" | "mtr" | "multiUnit";
    highestAllowed?: number;
    custom?: { rule?: "fixed" | "bookingValue"; weekday?: number; weekend?: number; bookingValue?: number };
    lastMinute?: Array<{ withinDays: number; weekday: number; weekend: number }>;
    farOut?: Array<{ beyondDays: number; weekday: number; weekend: number }>;
    adjacent?: {
      enabled?: boolean;
      afterNights?: number;
      afterWithinDays?: number;
      afterLeadFromDays?: number;
      afterLeadToDays?: number;
      beforeFlushFit?: boolean;
    };
    orphanGap?: {
      enabled?: boolean;
      strategy?: "lengthOfGap" | "gapMinus1" | "gapMinus2" | "fixed";
      fixedNights?: number;
      minGapNights?: number;
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
  "rounding",
  "smoothing",
  "freezeUnavailable",
  "neighborhoodProfile",
  "bookingRecency",
  "seasonalProfile",
  "pricingOffset",
  "weekend",
  "orphanDayPrices",
  "portfolioOccupancy",
  "minPrices",
  "safetyMinPrice",
  "minStayRules",
  "minStayHierarchy",
] as const;

export type RuleSectionKey = (typeof SECTION_KEYS)[number];

/** Section keys + display labels for the customizations Table View. */
export const RULE_SECTIONS: Array<{ key: RuleSectionKey; label: string }> = [
  { key: "seasonality", label: "Seasonality" },
  { key: "demandEvents", label: "Demand" },
  { key: "pacing", label: "Pacing" },
  { key: "occupancy", label: "Occupancy" },
  { key: "farOut", label: "Far-out" },
  { key: "lastMinute", label: "Last-minute" },
  { key: "adjacent", label: "Adjacent" },
  { key: "dayOfWeek", label: "Day-of-week" },
  { key: "los", label: "LOS / discounts" },
  { key: "extraPersonFee", label: "Extra person" },
  { key: "checkinCheckout", label: "Check-in/out" },
  { key: "rounding", label: "Rounding" },
  { key: "smoothing", label: "Smoothing" },
  { key: "freezeUnavailable", label: "Freeze unavail" },
  { key: "neighborhoodProfile", label: "Data source" },
  { key: "bookingRecency", label: "Booking recency" },
  { key: "seasonalProfile", label: "Seasonal profile" },
  { key: "pricingOffset", label: "Offset" },
  { key: "weekend", label: "Weekend days" },
  { key: "orphanDayPrices", label: "Orphan prices" },
  { key: "portfolioOccupancy", label: "Portfolio occ" },
  { key: "minPrices", label: "Min prices" },
  { key: "safetyMinPrice", label: "Safety min" },
  { key: "minStayRules", label: "Min stay" },
  { key: "minStayHierarchy", label: "Min-stay far-out" },
];

/** Which level supplies each customization section for a unit (Table View):
 *  "listing" | "subgroup:NAME" | "group:NAME" | "account" | null (code default).
 *  Mirrors resolveChain — the most specific level that defines a section wins. */
export function sectionSourcesForUnit(
  unit: Pick<Unit, "id" | "group" | "subgroup">,
): Record<RuleSectionKey, string | null> {
  const levels: Array<{ label: string; o: RuleOverrides }> = [
    { label: "account", o: getRuleOverrides("account") },
  ];
  if (unit.group) levels.push({ label: `group:${unit.group}`, o: getRuleOverrides(`group:${unit.group}`) });
  if (unit.subgroup)
    levels.push({ label: `subgroup:${unit.subgroup}`, o: getRuleOverrides(`group:${unit.subgroup}`) });
  levels.push({ label: "listing", o: getRuleOverrides(`unit:${unit.id}`) });
  const out = {} as Record<RuleSectionKey, string | null>;
  for (const k of SECTION_KEYS) {
    out[k] = null;
    for (const level of levels) {
      if (level.o[k] !== undefined) out[k] = level.label;
    }
  }
  return out;
}

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
    .map((r) => {
      const upTo = clampInt(r.upToGapNights, 1, 45, 2);
      return {
        fromGapNights: Math.min(clampInt(r.fromGapNights, 1, 45, 1), upTo),
        upToGapNights: upTo,
        mode: r.mode === "fixed" ? ("fixed" as const) : ("percent" as const),
        weekday: r.mode === "fixed" ? clampNum(r.weekday, 0, 100000, 0) : clampNum(r.weekday, -0.75, 5, 0),
        weekend: r.mode === "fixed" ? clampNum(r.weekend, 0, 100000, 0) : clampNum(r.weekend, -0.75, 5, 0),
        withinDays:
          r.withinDays == null || !Number.isFinite(r.withinDays) || r.withinDays <= 0
            ? null
            : Math.round(r.withinDays),
      };
    })
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
  // LOS tiers: ascending by minNights; "longer stays must not have higher
  // premiums" (PriceLabs validation) — each row's pct is capped at the
  // previous row's.
  const losTiers = (o.los?.tiers ?? d.los.tiers)
    .filter((t) => t && Number.isFinite(t.minNights) && t.minNights >= 1)
    .slice(0, 8)
    .map((t) => ({
      minNights: clampInt(t.minNights, 1, 365, 1),
      pct: clampNum(t.pct, -0.75, 5, 0),
      minPrice: t.minPrice != null && Number.isFinite(t.minPrice) ? Math.max(0, Math.round(t.minPrice)) : null,
      maxPrice: t.maxPrice != null && Number.isFinite(t.maxPrice) ? Math.max(0, Math.round(t.maxPrice)) : null,
    }))
    .sort((a, b) => a.minNights - b.minNights);
  for (let i = 1; i < losTiers.length; i++) {
    if (losTiers[i].pct > losTiers[i - 1].pct) losTiers[i].pct = losTiers[i - 1].pct;
  }
  los.tiers = losTiers;

  const epf = { ...d.extraPersonFee, ...o.extraPersonFee };
  epf.mode = epf.mode === "percent" ? "percent" : "fixed";
  epf.value = epf.mode === "percent" ? clampNum(epf.value, 0, 1, 0) : clampNum(epf.value, 0, 100000, 0);
  epf.afterGuests = clampInt(epf.afterGuests, 1, 20, d.extraPersonFee.afterGuests);

  // Resolve the attached CICO profile's day lists at read time; inline day
  // lists apply when no profile (all days when neither). Archived profiles
  // keep applying (PriceLabs). Plus last-minute rules + the Smart options.
  const days = (xs: number[] | undefined, fb: number[]): number[] => {
    const v = Array.isArray(xs)
      ? [...new Set(xs.map((x) => Math.round(x)).filter((x) => x >= 0 && x <= 6))]
      : [];
    return v.length ? v.sort() : fb;
  };
  const cco = o.checkinCheckout;
  const cicoProf = findCicoProfile(cco?.profile ?? d.checkinCheckout.profile);
  const checkinCheckout = {
    enabled: cco?.enabled ?? d.checkinCheckout.enabled,
    profile: cco?.profile ?? d.checkinCheckout.profile,
    allowedCheckin:
      cicoProf?.allowedCheckin ?? days(cco?.allowedCheckin, d.checkinCheckout.allowedCheckin),
    allowedCheckout:
      cicoProf?.allowedCheckout ?? days(cco?.allowedCheckout, d.checkinCheckout.allowedCheckout),
    lastMinute: (cco?.lastMinute ?? d.checkinCheckout.lastMinute)
      .filter((r) => r && Number.isFinite(r.withinDays) && r.withinDays > 0)
      .slice(0, 3)
      .map((r) => ({
        withinDays: clampInt(r.withinDays, 1, 365, 7),
        checkin: days(r.checkin, [0, 1, 2, 3, 4, 5, 6]),
        checkout: days(r.checkout, [0, 1, 2, 3, 4, 5, 6]),
      })),
    smart: {
      blockGapCreating: cco?.smart?.blockGapCreating ?? d.checkinCheckout.smart.blockGapCreating,
      maxGapNights: clampInt(cco?.smart?.maxGapNights, 1, 7, d.checkinCheckout.smart.maxGapNights),
      beyondDays: clampInt(cco?.smart?.beyondDays, 0, 365, d.checkinCheckout.smart.beyondDays),
      allowAdjacent: cco?.smart?.allowAdjacent ?? d.checkinCheckout.smart.allowAdjacent,
    },
  };

  // Per-listing OBA: preset matrices, market-driven (computed), or a named
  // custom profile resolved at read time (updates propagate everywhere).
  const occO = o.occupancy;
  const obaProfile =
    occO?.profile &&
    ["default", "marketDriven", "aggressive", "stepLastMinute", "farOutPremium", "superAggressive", "custom"].includes(occO.profile)
      ? occO.profile
      : d.occupancy.profile;
  const customName = occO?.customName ?? d.occupancy.customName;
  const namedOba = obaProfile === "custom" ? findObaProfile(customName) : null;
  const rawObaWindows =
    obaProfile === "marketDriven"
      ? []
      : obaProfile === "custom"
        ? (namedOba?.payload.windows ?? occO?.windows ?? d.occupancy.windows)
        : OBA_PRESETS[obaProfile as keyof typeof OBA_PRESETS];
  const occupancy = {
    enabled: occO?.enabled ?? d.occupancy.enabled,
    profile: obaProfile,
    customName,
    windows: (rawObaWindows ?? [])
      .slice(0, 6)
      .map((w) => ({
        uptoDays: clampInt(w.uptoDays, 1, 9999, 9999),
        bands: w.bands.map((b) => ({ ...b, adjust: clampNum(b.adjust, -0.5, 5, 0) })),
      }))
      .sort((a, b) => a.uptoDays - b.uptoDays),
  };

  const rounding = { ...d.rounding, ...o.rounding };
  rounding.digits = clampInt(rounding.digits, 1, 5, d.rounding.digits);
  const mod = 10 ** rounding.digits;
  const endings = (o.rounding?.endings ?? d.rounding.endings)
    .map((x) => Math.abs(Math.round(x)) % mod)
    .filter((x, i, arr) => Number.isFinite(x) && arr.indexOf(x) === i);
  rounding.endings = endings.length ? endings : d.rounding.endings;

  const smoothing = { ...d.smoothing, ...o.smoothing };
  smoothing.mode = smoothing.mode === "split" ? "split" : "week";
  smoothing.weekStart = [0, 5, 6].includes(Math.round(smoothing.weekStart))
    ? Math.round(smoothing.weekStart)
    : d.smoothing.weekStart;

  const demandSens =
    o.demandEvents?.sensitivity && o.demandEvents.sensitivity in SEASONALITY_SENSITIVITY
      ? o.demandEvents.sensitivity
      : d.demandEvents.sensitivity;

  const safetyMinPrice = { ...d.safetyMinPrice, ...o.safetyMinPrice };
  safetyMinPrice.pctOfLastYear = clampNum(safetyMinPrice.pctOfLastYear, 0.5, 3, d.safetyMinPrice.pctOfLastYear);

  // A named Min Stay Profile replaces the section's rules wholesale
  // (all-or-nothing — PriceLabs profile semantics); the unit floor still holds.
  const msProfileName = o.minStayRules?.profile ?? null;
  const msProfile = findMinStayProfile(msProfileName);
  const ms = msProfile
    ? (msProfile.payload as RuleOverrides["minStayRules"])
    : o.minStayRules;
  const minStayRules: PricingRulesConfig["minStayRules"] = {
    profile: msProfile ? msProfileName : null,
    mode: ms?.mode === "custom" || ms?.mode === "recommended" ? ms.mode : d.minStayRules.mode,
    recommendedFlavor: (["str", "mtr", "multiUnit"] as const).includes(ms?.recommendedFlavor as never)
      ? (ms!.recommendedFlavor as "str" | "mtr" | "multiUnit")
      : d.minStayRules.recommendedFlavor,
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
    farOut: (ms?.farOut ?? d.minStayRules.farOut)
      .filter((x) => x && Number.isFinite(x.beyondDays) && x.beyondDays >= 0)
      .slice(0, 8)
      .map((x) => ({
        beyondDays: clampInt(x.beyondDays, 0, 730, 0),
        weekday: clampInt(x.weekday, 1, 365, 1),
        weekend: clampInt(x.weekend, 1, 365, 1),
      }))
      .sort((a, b) => a.beyondDays - b.beyondDays),
    adjacent: {
      enabled: ms?.adjacent?.enabled ?? d.minStayRules.adjacent.enabled,
      afterNights: clampInt(ms?.adjacent?.afterNights, 1, 365, d.minStayRules.adjacent.afterNights),
      afterWithinDays: clampInt(ms?.adjacent?.afterWithinDays, 1, 30, d.minStayRules.adjacent.afterWithinDays),
      afterLeadFromDays: clampInt(ms?.adjacent?.afterLeadFromDays, 0, 730, d.minStayRules.adjacent.afterLeadFromDays),
      afterLeadToDays: clampInt(ms?.adjacent?.afterLeadToDays, 0, 999, d.minStayRules.adjacent.afterLeadToDays),
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
      minGapNights: clampInt(ms?.orphanGap?.minGapNights, 1, 45, d.minStayRules.orphanGap.minGapNights),
      maxGapNights: clampInt(ms?.orphanGap?.maxGapNights, 1, 45, d.minStayRules.orphanGap.maxGapNights),
      lowestAllowed: clampInt(ms?.orphanGap?.lowestAllowed, 1, 365, d.minStayRules.orphanGap.lowestAllowed),
    },
    adaptiveOccupancy: {
      enabled: ms?.adaptiveOccupancy?.enabled ?? d.minStayRules.adaptiveOccupancy.enabled,
    },
  };

  // Custom Seasonal Profile: resolve the attached profile's seasons, and for
  // seasons carrying a Pricing Profile / Min Stay Profile, pre-resolve a full
  // per-season engine config (seasonal customizations supersede the scope's;
  // the nested config has its own seasonalProfile disabled — no recursion).
  // PriceLabs disallows fixed last-minute / orphan prices inside Pricing
  // Profiles (one profile prices many listings) — those modes are stripped.
  const spo = o.seasonalProfile;
  const spStored = findSeasonalProfile(spo?.profile ?? d.seasonalProfile.profile);
  const MMDD = /^\d{2}-\d{2}$/;
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const seasonalProfile: PricingRulesConfig["seasonalProfile"] = {
    enabled: spo?.enabled ?? d.seasonalProfile.enabled,
    profile: spStored?.name ?? null,
    mode: spStored?.payload.mode === "percent" ? "percent" : "fixed",
    seasons: [],
  };
  if (spStored && seasonalProfile.enabled) {
    seasonalProfile.seasons = spStored.payload.seasons
      .filter((s) => {
        if (!s || typeof s.name !== "string" || !s.name.trim()) return false;
        const re = s.repeating ? MMDD : YMD;
        return re.test(String(s.from)) && re.test(String(s.to)) && String(s.from) <= String(s.to);
      })
      .slice(0, 24)
      .map((s) => {
        const num = (v: unknown): number | null =>
          v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
        const pp = findPricingProfile(s.pricingProfile);
        const msp = findMinStayProfile(s.minStayProfile);
        let cfg: PricingRulesConfig | null = null;
        if (pp || msp) {
          const ppOverrides = { ...(pp?.payload as RuleOverrides | undefined) };
          // Strip fixed price modes (not allowed in Pricing Profiles).
          if (ppOverrides.lastMinute?.mode === "fixed") {
            ppOverrides.lastMinute = { ...ppOverrides.lastMinute, mode: "gradual" };
          }
          if (ppOverrides.orphanDayPrices?.ranges) {
            ppOverrides.orphanDayPrices = {
              ...ppOverrides.orphanDayPrices,
              ranges: ppOverrides.orphanDayPrices.ranges.filter((r) => r.mode !== "fixed"),
            };
          }
          delete (ppOverrides as Record<string, unknown>).seasonalProfile;
          let seasonOverrides = mergeRuleOverrides(o, ppOverrides);
          if (msp) {
            const { profile: _mp, ...msRules } = (msp.payload ?? {}) as Record<string, unknown>;
            seasonOverrides = { ...seasonOverrides, minStayRules: msRules as RuleOverrides["minStayRules"] };
          }
          cfg = rulesWithOverrides({
            ...seasonOverrides,
            seasonalProfile: { enabled: false, profile: null },
          });
        }
        return {
          name: s.name.trim().slice(0, 60),
          from: String(s.from),
          to: String(s.to),
          repeating: !!s.repeating,
          min: num(s.min),
          base: num(s.base),
          max: num(s.max),
          minStayProfile: msp?.name ?? null,
          pricingProfile: pp?.name ?? null,
          cfg,
        };
      });
  }

  return {
    currentRateLeadDays: o.currentRateLeadDays ?? d.currentRateLeadDays,
    curveHorizonDays: d.curveHorizonDays,
    seasonality: { ...d.seasonality, ...o.seasonality, sensitivity: sens },
    demandEvents: { ...d.demandEvents, ...o.demandEvents, sensitivity: demandSens },
    pacing: { ...d.pacing, ...o.pacing },
    occupancy,
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
    rounding,
    smoothing,
    freezeUnavailable: { enabled: o.freezeUnavailable?.enabled ?? d.freezeUnavailable.enabled },
    neighborhoodProfile: {
      source: (o.neighborhoodProfile?.source ?? d.neighborhoodProfile.source)?.trim() || null,
    },
    bookingRecency: { enabled: o.bookingRecency?.enabled ?? d.bookingRecency.enabled },
    seasonalProfile,
    pricingOffset,
    weekend,
    orphanDayPrices,
    portfolioOccupancy,
    minPrices,
    safetyMinPrice,
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

/** The unit's effective market profile (Neighborhood Profile Data Source) —
 *  the scoped override when set, else the listing's own neighborhood. Providers
 *  use this to pick which market snapshot feeds recommendations. */
export function effectiveNeighborhood(
  unit: Pick<Unit, "id" | "group" | "subgroup" | "neighborhood">,
): string {
  return effectiveRulesForUnit(unit).neighborhoodProfile.source ?? unit.neighborhood;
}

/** The ±% human gate (spec §5), operator-overridable within sane bounds. */
export function effectiveHumanGatePct(): number {
  const o = getRuleOverrides("account").humanGatePct;
  if (o == null || !Number.isFinite(o)) return PRICING_AGENT.humanGatePct;
  return Math.min(50, Math.max(1, o));
}
