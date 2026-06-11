// Smart Presets (PriceLabs): tailored recommended customizations by property
// type + dynamic-pricing experience. Each preset is a RuleOverrides patch over
// the engine's defaults, with a light-bulb explanation per item. Applying a
// preset SAVES the patch to the chosen scope (account/group/listing) — it uses
// the same sections every other batch built, so presets are pure configuration.

import type { RuleOverrides } from "@/lib/pricing/rules-config";

export interface SmartPresetItem {
  label: string;
  why: string;
}

export interface SmartPreset {
  key: string;
  label: string;
  blurb: string;
  patch: RuleOverrides;
  items: SmartPresetItem[];
}

export const PROPERTY_TYPES = [
  "str",
  "mtr",
  "hotel_independent",
  "hotel_group",
  "bnb",
  "resort",
  "aparthotel",
  "serviced_apartments",
  "hostel",
  "campground",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

const STR_PATCH: RuleOverrides = {
  lastMinute: { enabled: true, mode: "gradual", windowDays: 15, value: -0.3 },
  dayOfWeek: { enabled: true },
  adjacent: { enabled: true, mode: "percent", value: -0.1, daysBefore: 2, daysAfter: 2 },
  orphanDayPrices: {
    enabled: true,
    ranges: [{ upToGapNights: 2, mode: "percent", weekday: -0.2, weekend: -0.2, withinDays: null }],
  },
  occupancy: { enabled: true, profile: "default" },
  minStayRules: {
    mode: "recommended",
    recommendedFlavor: "str",
    orphanGap: { enabled: true, strategy: "lengthOfGap", maxGapNights: 4, lowestAllowed: 1 },
    adaptiveOccupancy: { enabled: true },
  },
  seasonality: { enabled: true, sensitivity: "recommended" },
  demandEvents: { enabled: true, sensitivity: "recommended" },
};

const MTR_PATCH: RuleOverrides = {
  lastMinute: { enabled: false },
  dayOfWeek: { enabled: false },
  adjacent: { enabled: false },
  orphanDayPrices: { enabled: false },
  farOut: { enabled: true, mode: "gradual" },
  seasonality: { enabled: true, sensitivity: "conservative" },
  demandEvents: { enabled: true, sensitivity: "conservative" },
  minStayRules: { mode: "recommended", recommendedFlavor: "mtr", adaptiveOccupancy: { enabled: true } },
  safetyMinPrice: { enabled: true, pctOfLastYear: 1.1 },
  freezeUnavailable: { enabled: true },
  bookingRecency: { enabled: true },
};

const MULTI_UNIT_PATCH: RuleOverrides = {
  portfolioOccupancy: { enabled: true, profile: "medium" },
  occupancy: { enabled: true, profile: "marketDriven" },
  minStayRules: { mode: "recommended", recommendedFlavor: "multiUnit", adaptiveOccupancy: { enabled: true } },
  smoothing: { enabled: true, mode: "split", weekStart: 5 },
  demandEvents: { enabled: true, sensitivity: "moderately_conservative" },
};

export const SMART_PRESETS: Record<PropertyType, SmartPreset> = {
  str: {
    key: "str",
    label: "Short-Term Rentals",
    blurb: "Nightly turnover mechanics on: lead-time discounts, gap management, day-of-week.",
    patch: STR_PATCH,
    items: [
      { label: "Last-minute prices (gradual 30% / 15d)", why: "Unsold near dates convert better with a ramping discount." },
      { label: "Day-of-week + adjacent factor", why: "Weekend premiums and back-to-back gap control are core STR levers." },
      { label: "Orphan day prices (20% on ≤2-night gaps)", why: "Short scraps between bookings rarely sell at full rate." },
      { label: "Min-stay: Recommended (Short-Term) + orphan gap fill", why: "Opportunity-cost engine with 1-night gap fills." },
    ],
  },
  mtr: {
    key: "mtr",
    label: "Mid-Term Rentals",
    blurb: "30+ night economics: protect monthly rates, ignore nightly turnover machinery.",
    patch: MTR_PATCH,
    items: [
      { label: "Last-minute / day-of-week / orphan OFF", why: "You don't discount a 30+ night stay because arrival is near." },
      { label: "Conservative seasonality & demand", why: "Long-stay demand is smoother than nightly STR swings." },
      { label: "Far-out premium + Safety Minimum Price", why: "Hold distant inventory and floor it at last year's realized rates." },
      { label: "Freeze unavailable + booking recency", why: "No cancel-rebook-cheaper; auto-revive listings going cold." },
    ],
  },
  hotel_independent: {
    key: "hotel_independent",
    label: "Independent Hotels",
    blurb: "Room-type revenue management: portfolio occupancy drives price.",
    patch: MULTI_UNIT_PATCH,
    items: [
      { label: "Portfolio occupancy-based adjustments", why: "Combined room-type occupancy is the hotel pricing signal." },
      { label: "Market-driven OBA + multi-unit min-stay", why: "Own-vs-market fill steers discounts/premiums." },
      { label: "Smoothing (weekday/weekend)", why: "Uniform rates within the week read cleaner on hotel channels." },
    ],
  },
  hotel_group: {
    key: "hotel_group",
    label: "Group Hotels",
    blurb: "Same as independent hotels — manage room types via customization groups.",
    patch: MULTI_UNIT_PATCH,
    items: [
      { label: "Portfolio OBA across groups", why: "Group your room types and price off combined occupancy." },
      { label: "Group-level customizations", why: "Push one strategy across every property from the group scope." },
    ],
  },
  bnb: {
    key: "bnb",
    label: "B&Bs and Inns",
    blurb: "Small multi-room: STR mechanics softened, portfolio occupancy on.",
    patch: {
      ...STR_PATCH,
      portfolioOccupancy: { enabled: true, profile: "short" },
      demandEvents: { enabled: true, sensitivity: "moderately_conservative" },
    },
    items: [
      { label: "STR levers + portfolio occupancy", why: "Few rooms swing occupancy fast — combined occupancy stabilizes it." },
      { label: "Moderately conservative demand", why: "Small comp sets make event spikes noisy." },
    ],
  },
  resort: {
    key: "resort",
    label: "Resorts",
    blurb: "Highly seasonal demand: amplify the seasonal curve, hold far-out inventory.",
    patch: {
      ...MULTI_UNIT_PATCH,
      seasonality: { enabled: true, sensitivity: "aggressive" },
      farOut: { enabled: true, mode: "marketDriven", marketFlavor: "aggressive" },
    },
    items: [
      { label: "Aggressive seasonality", why: "Peak/off-peak spreads are the resort revenue story." },
      { label: "Market-driven far-out (aggressive)", why: "Distant peak dates should be the last to sell, at a premium." },
    ],
  },
  aparthotel: {
    key: "aparthotel",
    label: "Apart-Hotels",
    blurb: "Hybrid: multi-unit occupancy pricing with mid-term stay economics.",
    patch: {
      ...MULTI_UNIT_PATCH,
      los: { enabled: true, weeklyPct: 0.1, monthlyPct: 0.2, tiers: [] },
      minStayRules: { mode: "recommended", recommendedFlavor: "multiUnit", adaptiveOccupancy: { enabled: true } },
    },
    items: [
      { label: "Portfolio occupancy + weekly/monthly discounts", why: "Sell the building's occupancy and the long-stay rate together." },
      { label: "Multi-unit min-stay recommendations", why: "Gentler bumps tuned to many identical units." },
    ],
  },
  serviced_apartments: {
    key: "serviced_apartments",
    label: "Serviced Apartments",
    blurb: "Corporate long-stay demand: the mid-term preset plus portfolio occupancy.",
    patch: {
      ...MTR_PATCH,
      portfolioOccupancy: { enabled: true, profile: "long" },
    },
    items: [
      { label: "Mid-term preset", why: "Monthly economics dominate corporate housing." },
      { label: "Portfolio occupancy (long windows)", why: "Balance sell-through across identical units on long horizons." },
    ],
  },
  hostel: {
    key: "hostel",
    label: "Hostels",
    blurb: "High-velocity, price-sensitive demand: aggressive occupancy discounting.",
    patch: {
      ...STR_PATCH,
      occupancy: { enabled: true, profile: "superAggressive" },
      lastMinute: { enabled: true, mode: "marketDriven", marketFlavor: "aggressive", windowDays: 30 },
    },
    items: [
      { label: "Super-aggressive OBA", why: "Beds unsold tonight are worthless — discount hard when empty." },
      { label: "Market-driven last-minute (aggressive)", why: "Track the market's near-in discounting closely." },
    ],
  },
  campground: {
    key: "campground",
    label: "Campgrounds, RV & Holiday Parks",
    blurb: "Seasonal + weekend-heavy: strong seasonality, day-of-week, step discounts.",
    patch: {
      ...STR_PATCH,
      seasonality: { enabled: true, sensitivity: "aggressive" },
      occupancy: { enabled: true, profile: "stepLastMinute" },
    },
    items: [
      { label: "Aggressive seasonality + day-of-week", why: "Summer weekends carry the year." },
      { label: "Step last-minute occupancy discounts", why: "Predictable step-downs suit walk-up demand." },
    ],
  },
};

/** New-to-dynamic-pricing operators get one notch more conservative: softer
 *  sensitivities and a tighter human gate, so the engine earns trust first. */
export function adjustForExperience(patch: RuleOverrides, experienced: boolean): RuleOverrides {
  if (experienced) return patch;
  const soften = (s: string | undefined): "conservative" | "moderately_conservative" =>
    s === "recommended" || s === "moderately_aggressive" || s === "aggressive"
      ? "moderately_conservative"
      : "conservative";
  return {
    ...patch,
    seasonality: { ...patch.seasonality, sensitivity: soften(patch.seasonality?.sensitivity) },
    demandEvents: { ...patch.demandEvents, sensitivity: soften(patch.demandEvents?.sensitivity) },
    humanGatePct: 10,
  };
}
