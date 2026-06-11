// Single source of truth for the Pricing Specialist's tunable knobs and the
// per-unit pricing defaults. Every pricing "magic number" lives here so it can
// be reviewed in one place (and so a future in-app config editor has one target
// to read/write). Changing a value here changes the default for newly-seeded /
// migrated units and the agent's behaviour on the next pass.
//
// Note: per-unit values are stored on the `units` row once set; editing a
// default here does NOT retroactively change units that already have a value.

/** Per-unit pricing defaults. Used as DB column defaults / backfills (db.ts) and
 *  as read-time fallbacks (units.ts). Percentages are fractions (0.8 = 80%). */
export const UNIT_PRICING_DEFAULTS = {
  /** AUTO price floor as a fraction of Base (PriceLabs "min price") — applies
   *  while the unit's min isn't pinned in the Rates Calendar (NULL min_rate);
   *  auto bounds re-follow Base on every edit. */
  floorPctOfBase: 0.8,
  /** AUTO price ceiling as a fraction of Base (surge cap) — same pin semantics. */
  ceilingPctOfBase: 1.2,
  /** Weekly LOS discount (0..1). */
  weeklyDiscountPct: 0.1,
  /** Monthly LOS discount (0..1) — the headline mid-term lever. */
  monthlyDiscountPct: 0.2,
  /** Recommended minimum stay, nights (the agent flexes this with demand). */
  minStay: 3,
  /** Hard minimum-stay floor, nights. The operator's live PriceLabs setup runs
   *  a 3-night default with gap-1 orphan fills, so the floor sits at 1. */
  lowestMinStay: 1,
} as const;

/** Agent tuning constants for a pricing pass. */
export const PRICING_AGENT = {
  /** Moves beyond ±this% escalate to the Action Center (spec.md §5). */
  humanGatePct: 15,
  /** Upper bound on a recommended minimum stay, nights. */
  maxMinStay: 90,
  /** Rates are rounded to the nearest multiple of this (ILS). */
  roundingStep: 5,
  /** Weight of the demand signal in the per-unit tilt. */
  demandWeight: 0.7,
  /** Weight of the occupancy gap in the per-unit tilt. */
  occupancyWeight: 0.3,
  /** Target occupancy the occupancy-tilt pulls toward. */
  targetOccupancy: 0.85,
  /** Slope applied to the occupancy gap before clamping. */
  occupancyTiltSlope: 1.5,
  /** Occupancy tilt is clamped to ±this. */
  occupancyTiltCap: 0.2,
  /** Single-pass move is clamped to ±this before the human gate. */
  singlePassClamp: 0.25,
  /** Moves smaller than ±this% are treated as no-ops (not written/logged). */
  noOpThresholdPct: 0.5,
  /** Escalations at or above ±this% are flagged "high" blast radius (else "medium"). */
  highBlastRadiusPct: 20,
  /** Min-stay bumps, highest threshold first: demand ≥ threshold ⇒ floor + bump. */
  minStayDemandTiers: [
    { threshold: 0.2, bump: 30, label: "hot demand" },
    { threshold: 0.12, bump: 15, label: "firm demand" },
  ],
} as const;

/** Round a rate to the configured ₪ step. */
export function roundRate(value: number): number {
  const step = PRICING_AGENT.roundingStep;
  return Math.round(value / step) * step;
}

// ---------------------------------------------------------------------------
// Pricing RULE ENGINE config — the "wide rule set" for how a nightly price is
// built. Every rule below is individually tunable and toggleable; the engine
// (src/lib/pricing/engine.ts) applies the enabled ones in order as multipliers
// on the base rate, then clamps to the unit's floor/ceiling. Defaults are tuned
// for a Tel Aviv mid-term (30–90+ night) portfolio: STR-only mechanics
// (last-minute discounting, day-of-week) ship implemented but OFF by default.
// ---------------------------------------------------------------------------

export interface OccupancyBand {
  /** Applies when forward occupancy < this ceiling (0..1.01). Ordered ascending. */
  upTo: number;
  /** Price adjustment as a fraction (e.g. -0.05 = 5% cheaper). */
  adjust: number;
  label: string;
}

/** Seasonality Factor Sensitivity (PriceLabs presets). Scales how strongly the
 *  seasonal curve moves prices: factor = 1 + (index − 1) × amplitude, so
 *  "conservative" tones highs down / lifts lows up and "aggressive" amplifies. */
export type SeasonalitySensitivity =
  | "none"
  | "conservative"
  | "moderately_conservative"
  | "recommended"
  | "moderately_aggressive"
  | "aggressive";

export const SEASONALITY_SENSITIVITY: Record<
  SeasonalitySensitivity,
  { amplitude: number; label: string }
> = {
  none: { amplitude: 0, label: "No Seasonality" },
  conservative: { amplitude: 0.5, label: "Conservative" },
  moderately_conservative: { amplitude: 0.75, label: "Moderately Conservative" },
  recommended: { amplitude: 1, label: "Recommended" },
  moderately_aggressive: { amplitude: 1.25, label: "Moderately Aggressive" },
  aggressive: { amplitude: 1.5, label: "Aggressive" },
};

/** PriceLabs Pricing Offset bounds: discounts cap at 40 (% or ₪), premiums at 500. */
export const PRICING_OFFSET_LIMITS = {
  percent: { min: -0.4, max: 5 },
  fixed: { min: -40, max: 500 },
} as const;

/** How a minimum-price customization expresses its value (PriceLabs options):
 *  fixed ₪, % change on the base price, or % change on the listing min price. */
export type MinPriceMode = "fixed" | "pctBase" | "pctMin";

/** Market-driven flavor (HLP-style): how hard to lean into market-derived
 *  last-minute discounts / far-out premiums. */
export type MarketFlavor = "conservative" | "balanced" | "aggressive";

export const MARKET_FLAVOR_MULT: Record<MarketFlavor, number> = {
  conservative: 0.5,
  balanced: 1,
  aggressive: 1.5,
};

/** One booking-window column of a Portfolio Occupancy profile. */
export interface PortfolioObaWindow {
  /** Window applies to lead times ≤ this many days (ascending; last is catch-all). */
  uptoDays: number;
  bands: OccupancyBand[];
}

const obaBands = (adjusts: [number, number, number, number]): OccupancyBand[] => [
  { upTo: 0.5, adjust: adjusts[0], label: "soft <50%" },
  { upTo: 0.8, adjust: adjusts[1], label: "healthy 50–80%" },
  { upTo: 0.95, adjust: adjusts[2], label: "tight 80–95%" },
  { upTo: 1.01, adjust: adjusts[3], label: "full 95%+" },
];

/** Per-listing OBA preset profiles (PriceLabs's named options; exact matrices
 *  are ours, shaped to each profile's description). marketDriven is computed,
 *  not a matrix. */
export const OBA_PRESETS: Record<
  "default" | "aggressive" | "superAggressive" | "stepLastMinute" | "farOutPremium",
  PortfolioObaWindow[]
> = {
  default: [
    { uptoDays: 15, bands: obaBands([-0.15, -0.05, 0.05, 0.1]) },
    { uptoDays: 30, bands: obaBands([-0.1, -0.03, 0.03, 0.08]) },
    { uptoDays: 9999, bands: obaBands([-0.05, 0, 0.03, 0.05]) },
  ],
  aggressive: [
    { uptoDays: 15, bands: obaBands([-0.3, -0.1, 0.08, 0.2]) },
    { uptoDays: 30, bands: obaBands([-0.2, -0.05, 0.05, 0.15]) },
    { uptoDays: 60, bands: obaBands([-0.1, 0, 0.05, 0.1]) },
    { uptoDays: 9999, bands: obaBands([0, 0, 0, 0]) },
  ],
  superAggressive: [
    { uptoDays: 15, bands: obaBands([-0.45, -0.2, 0.08, 0.15]) },
    { uptoDays: 30, bands: obaBands([-0.35, -0.12, 0.05, 0.12]) },
    { uptoDays: 9999, bands: obaBands([-0.2, -0.05, 0.05, 0.08]) },
  ],
  stepLastMinute: [
    { uptoDays: 7, bands: obaBands([-0.25, -0.25, 0, 0]) },
    { uptoDays: 14, bands: obaBands([-0.15, -0.15, 0, 0]) },
    { uptoDays: 30, bands: obaBands([-0.08, -0.08, 0, 0]) },
    { uptoDays: 9999, bands: obaBands([0, 0, 0, 0]) },
  ],
  farOutPremium: [
    { uptoDays: 60, bands: obaBands([0, 0, 0, 0]) },
    { uptoDays: 120, bands: obaBands([0, 0, 0.05, 0.08]) },
    { uptoDays: 9999, bands: obaBands([0.05, 0.05, 0.1, 0.15]) },
  ],
};

/** PriceLabs' pre-filled Portfolio OBA profiles by booking-window range. The
 *  exact matrices are ours; the windows mirror the documented targets (short
 *  11–20d, medium 16–30d, long 31–60d to reach ~50% occupancy). */
export const PORTFOLIO_OBA_PRESETS: Record<"short" | "medium" | "long", PortfolioObaWindow[]> = {
  short: [
    { uptoDays: 10, bands: obaBands([-0.15, -0.05, 0.05, 0.15]) },
    { uptoDays: 20, bands: obaBands([-0.1, 0, 0.05, 0.1]) },
    { uptoDays: 9999, bands: obaBands([-0.05, 0, 0.03, 0.08]) },
  ],
  medium: [
    { uptoDays: 15, bands: obaBands([-0.15, -0.05, 0.05, 0.15]) },
    { uptoDays: 30, bands: obaBands([-0.1, 0, 0.05, 0.1]) },
    { uptoDays: 9999, bands: obaBands([-0.05, 0, 0.03, 0.08]) },
  ],
  long: [
    { uptoDays: 30, bands: obaBands([-0.12, -0.04, 0.04, 0.12]) },
    { uptoDays: 60, bands: obaBands([-0.08, 0, 0.04, 0.08]) },
    { uptoDays: 9999, bands: obaBands([-0.04, 0, 0.02, 0.06]) },
  ],
};

/** The full rule-engine configuration. Code defaults live in PRICING_RULES;
 *  operator overrides (Pricing Configuration → engine rules) are deep-merged over
 *  them at read time via src/lib/pricing/rules-config.ts. */
export interface PricingRulesConfig {
  currentRateLeadDays: number;
  curveHorizonDays: number;
  seasonality: { enabled: boolean; sensitivity: SeasonalitySensitivity; monthlyIndex: number[] };
  /** Demand Factor Sensitivity reuses the same six presets: scales how hard
   *  date-specific demand (events/holidays) moves prices, before the cap.
   *  (PriceLabs Hotel Weights / Hotel Compsets are not applicable — we have no
   *  Booking.com hotel feed.) */
  demandEvents: { enabled: boolean; sensitivity: SeasonalitySensitivity; cap: number };
  pacing: { enabled: boolean; sensitivity: number; cap: number };
  /** Occupancy-Based Adjustments: the listing's OWN occupancy over each booking
   *  window (booked+blocked nights ÷ window nights — MiniHotel isn't in
   *  PriceLabs's blocked-dates exception list) drives a per-window band matrix.
   *  Profiles: default / aggressive / superAggressive / stepLastMinute /
   *  farOutPremium presets, marketDriven (own vs market occupancy, next 60d,
   *  discount ≤20% / premium ≤15%), or a named custom profile (updating a
   *  profile propagates everywhere it's attached). */
  occupancy: {
    enabled: boolean;
    profile:
      | "default"
      | "marketDriven"
      | "aggressive"
      | "stepLastMinute"
      | "farOutPremium"
      | "superAggressive"
      | "custom";
    /** Named custom profile (repos/profiles); inline windows used when null. */
    customName: string | null;
    windows: PortfolioObaWindow[];
  };
  /** Far Out Prices: gradual ramp, flat premium/discount beyond a threshold, or
   *  market-driven (flavored; capped at ±20% and never before 60 days out —
   *  PriceLabs's documented limits for the market mode). `cap` is signed. */
  farOut: {
    enabled: boolean;
    mode: "gradual" | "flat" | "marketDriven";
    marketFlavor: MarketFlavor;
    thresholdDays: number;
    cap: number;
    rampDays: number;
  };
  /** Last Minute Prices: gradual, % flat, fixed nightly price (a pin), or
   *  market-driven (flavored). Custom windows max out at 90 days (PriceLabs).
   *  `value` is a signed fraction for percent modes, ₪ for fixed. */
  lastMinute: {
    enabled: boolean;
    mode: "gradual" | "flat" | "fixed" | "marketDriven";
    marketFlavor: MarketFlavor;
    windowDays: number;
    value: number;
  };
  adjacent: {
    enabled: boolean;
    mode: "percent" | "fixed";
    /** Signed: negative = discount, positive = premium. Fraction when percent, ₪ when fixed. */
    value: number;
    /** Open days before a booking's first night that qualify (0..30). */
    daysBefore: number;
    /** Open days after a booking's last night that qualify (0..30). */
    daysAfter: number;
    /** PriceLabs default: adjacency skips weekends (Fri/Sat here) unless opted in. */
    applyOnWeekends: boolean;
  };
  dayOfWeek: { enabled: boolean; multiplier: number[] };
  /** LOS pricing adjustments. weeklyPct/monthlyPct (0..0.75, PriceLabs range)
   *  override the per-unit columns when set at a scope; null = unit's own.
   *  `tiers` are full LOS rows ("≥ nights → ±%", premiums for short stays,
   *  discounts for long), applied after all other customizations, with optional
   *  per-NIGHT min/max for that stay length. PriceLabs validation: longer stays
   *  must not carry higher premiums (enforced in sanitization). Quote-side
   *  only: MiniHotel isn't in PriceLabs's LOS/weekly/monthly push lists. */
  los: {
    enabled: boolean;
    weeklyPct: number | null;
    monthlyPct: number | null;
    quarterlyMinNights: number;
    quarterlyDiscountPct: number;
    tiers: Array<{
      minNights: number;
      /** Signed fraction: negative = discount, positive = premium. */
      pct: number;
      /** Optional per-night floor/ceiling for stays of this length. */
      minPrice: number | null;
      maxPrice: number | null;
    }>;
  };
  /** Extra Person Fee: per extra guest per night above the threshold. Percent
   *  mode is computed off the check-in day's rate only (PriceLabs sends no
   *  per-night variation for this fee). */
  extraPersonFee: {
    enabled: boolean;
    mode: "fixed" | "percent";
    value: number;
    afterGuests: number;
  };
  /** Check-in/Check-out restrictions: a named profile OR inline day lists
   *  (profile wins when attached), optional last-minute rules that swap the day
   *  lists near arrival, and the two Smart options — block check-ins/outs that
   *  would create short orphan gaps, and re-open days adjacent to bookings.
   *  Engine-side restriction — our MiniHotel Reverse ARI contract (§4.2) has no
   *  verified CTA/CTD field, so this is not pushed. */
  checkinCheckout: {
    enabled: boolean;
    profile: string | null;
    allowedCheckin: number[];
    allowedCheckout: number[];
    /** Up to 3: different day lists within N days of arrival. */
    lastMinute: Array<{ withinDays: number; checkin: number[]; checkout: number[] }>;
    smart: {
      /** Block check-ins/check-outs that would CREATE a gap of ≤ maxGapNights
       *  (only beyond `beyondDays` from today). */
      blockGapCreating: boolean;
      maxGapNights: number;
      beyondDays: number;
      /** Re-open check-in/check-out on nights flush against an existing booking. */
      allowAdjacent: boolean;
    };
  };
  /** Rounding (Advanced): snap the FINAL price's trailing `digits` digits to the
   *  nearest allowed ending. Applied last, after the offset; still respects the
   *  min/max bounds, and any pinned fixed price bypasses it. */
  rounding: { enabled: boolean; digits: number; endings: number[] };
  /** Smoothing (Advanced): average nightly rates across the week containing the
   *  date — whole week or weekdays/weekends separately (per the Weekend Days
   *  customization) — for a uniform guest-facing rate. Pinned prices bypass it. */
  smoothing: { enabled: boolean; mode: "week" | "split"; weekStart: number };
  /** No Price Updates For Unavailable Nights: freeze synced prices on booked/
   *  blocked dates (prevents cancel-and-rebook-cheaper exploits). Calendar
   *  pushes drop the price field for unavailable nights while ON; min-stay /
   *  availability fields still flow. */
  freezeUnavailable: { enabled: boolean };
  /** Neighborhood Profile Data Source: which market profile feeds this scope's
   *  recommendations — null = the listing's own neighborhood. Scoped, so a
   *  group can price off a different comp market. */
  neighborhoodProfile: { source: string | null };
  /** Booking Recency Factor: an automatic temporary discount for listings that
   *  haven't booked in 15+ days AND are running cold (own next-30d occupancy
   *  <10%, or <80% of market and <70%). Linear 5%→15% over 15→45 days since the
   *  last booking, next 30 days only, respects the minimum price. Needs fresh
   *  reservation data (<3 days) — inert without it. On by default (PriceLabs). */
  bookingRecency: { enabled: boolean };
  /** Custom Seasonal Profile attachment: named seasons replacing the listing's
   *  min/base/max (fixed ₪ or % change), each optionally carrying a Min Stay
   *  Profile and a Pricing Profile. Resolved at read time into `seasons`
   *  (non-repeating seasons take preference over repeating ones); per-season
   *  `cfg` is the pre-resolved engine config when profiles are attached. */
  seasonalProfile: {
    enabled: boolean;
    profile: string | null;
    mode: "fixed" | "percent";
    seasons: Array<{
      name: string;
      from: string;
      to: string;
      repeating: boolean;
      min: number | null;
      base: number | null;
      max: number | null;
      minStayProfile: string | null;
      pricingProfile: string | null;
      /** Pre-resolved per-season config (season's profiles applied; its own
       *  seasonalProfile disabled to prevent recursion), or null = use this cfg. */
      cfg?: PricingRulesConfig | null;
    }>;
  };
  pricingOffset: {
    enabled: boolean;
    mode: "percent" | "fixed";
    /** Signed; fraction when percent (−0.4..5), ₪ when fixed (−40..500). */
    value: number;
  };
  /** "Weekend Days" customization: which UTC weekdays (0=Sun..6=Sat) count as
   *  weekend for orphan/min-stay/min-price weekday-vs-weekend splits. TLV
   *  default Fri/Sat. (Display weekends in the Rates Calendar are unchanged.) */
  weekend: { days: number[] };
  /** Orphan Day Prices: adjust the price of short open gaps between bookings.
   *  Up to 5 ranges by ascending gap length; values are weekday/weekend split.
   *  percent = signed fraction; fixed = an absolute nightly price (a pin, not
   *  an adjustment — PriceLabs "Fixed Pricing"). Percent entries join the
   *  last-minute/adjacent stacking rules. */
  orphanDayPrices: {
    enabled: boolean;
    ranges: Array<{
      /** Gap-length window in nights (from..upTo, inclusive). */
      fromGapNights: number;
      upToGapNights: number;
      mode: "percent" | "fixed";
      weekday: number;
      weekend: number;
      /** Only within this lead time (days), or null = always. */
      withinDays: number | null;
    }>;
  };
  /** Portfolio Occupancy-Based Adjustments: price each date off the COMBINED
   *  occupancy of the unit's customization group, per booking-window column.
   *  No-op for units without a group (single units swing 0↔100%). Applied
   *  pre-clamp, so floors/ceilings still hold (unlike the pricing offset). */
  portfolioOccupancy: {
    enabled: boolean;
    profile: "short" | "medium" | "long" | "custom";
    /** The active matrix; presets fill it, "custom" lets the operator edit. */
    windows: PortfolioObaWindow[];
  };
  /** Advanced Minimum Price settings — date-conditional floors that replace or
   *  raise the listing min. farOut/weekend only ever RAISE the floor;
   *  lastMinute/orphan REPLACE it (and may sit below the listing min — that's
   *  their documented point). */
  minPrices: {
    farOut: { enabled: boolean; beyondDays: number; mode: MinPriceMode; value: number };
    weekend: { enabled: boolean; mode: MinPriceMode; value: number };
    lastMinute: { enabled: boolean; withinDays: number; mode: MinPriceMode; value: number };
    orphan: { enabled: boolean; mode: MinPriceMode; value: number };
  };
  /** Safety Minimum Price (SMP): a raises-only floor anchored on LAST YEAR'S
   *  realized nightly rate for the same weekday (STLY ±1 week, weighted toward
   *  STLY; event-hot dates take the range MAX), times an inflation factor.
   *  Needs nightly revenue history (MiniHotel reservations) — silently inert
   *  for dates/units without it, mirroring PriceLabs's PMS gating. Never
   *  applies below the listing min. */
  safetyMinPrice: { enabled: boolean; pctOfLastYear: number };
  /** Dynamic Minimum Stay restrictions (full PriceLabs hierarchy; resolution
   *  order lives in engine.resolveMinStay). MiniHotel's MinimumNights field is
   *  min-stay-THROUGH semantics. */
  minStayRules: {
    /** Named Min Stay Profile: when attached, the profile's rules REPLACE this
     *  section wholesale (all-or-nothing — PriceLabs profile semantics). The
     *  per-unit lowestMinStay floor still applies regardless. */
    profile: string | null;
    /** recommended = engine-driven (demand tiers + market median); custom = the rules below. */
    mode: "recommended" | "custom";
    /** Recommended-mode flavor (Min Stay Recommendation Engine): mtr keeps the
     *  +15/+30-night demand bumps; str/multiUnit use ±1/±2-night bumps (short-
     *  term opportunity-cost scale; "prefer short-term" drops 15+ night demand). */
    recommendedFlavor: "str" | "mtr" | "multiUnit";
    /** Highest Minimum Stay Allowed — recommendations never exceed this. */
    highestAllowed: number;
    /** Custom default rule: fixed weekday/weekend nights, or a min booking value
     *  (₪) the stay must gross (nights ≈ value ÷ nightly rate). */
    custom: { rule: "fixed" | "bookingValue"; weekday: number; weekend: number; bookingValue: number };
    /** Up to 3 last-minute rules: lower the min stay near check-in. */
    lastMinute: Array<{ withinDays: number; weekday: number; weekend: number }>;
    /** Far-out min-stay LADDER: "beyond N days require X nights" rungs, the
     *  largest matching rung winning. Empty = fall back to the single legacy
     *  minStayHierarchy rule. */
    farOut: Array<{ beyondDays: number; weekday: number; weekend: number }>;
    /** Adjacent-day min stays. after = dates within `afterWithinDays` after an
     *  unavailable (booked OR blocked) night get `afterNights`, applying only
     *  for lead times in [afterLeadFromDays..afterLeadToDays]; before = stays
     *  that end flush against the next booking (no gap created). */
    adjacent: {
      enabled: boolean;
      afterNights: number;
      afterWithinDays: number;
      afterLeadFromDays: number;
      afterLeadToDays: number;
      beforeFlushFit: boolean;
    };
    /** Orphan-gap min stay: shrink the min stay to make short gaps bookable.
     *  Only ever REDUCES (PriceLabs rule), with its own floor (Lowest Orphan
     *  Gap Allowed — may sit below the unit's lowestMinStay). */
    orphanGap: {
      enabled: boolean;
      strategy: "lengthOfGap" | "gapMinus1" | "gapMinus2" | "fixed";
      fixedNights: number;
      /** Gap-length window in nights the rule applies to. */
      minGapNights: number;
      maxGapNights: number;
      lowestAllowed: number;
    };
    /** Adaptive Occupancy Adjustment: −1 night when own forward occupancy runs
     *  10–20% (relative) below market, −2 beyond that; never below the floor. */
    adaptiveOccupancy: { enabled: boolean };
  };
  minStayHierarchy: { farOutThresholdDays: number; farOutNights: number };
}

export const PRICING_RULES: PricingRulesConfig = {
  /** Lead-time (days out) at which the headline "current rate" is quoted. 0 = price
   *  as-of-now (intuitive headline); the forward view, incl. far-out premiums, is
   *  in the price curve. Raise it to price a typical booking window instead. */
  currentRateLeadDays: 0,
  /** Horizon (days) for the per-date price curve. */
  curveHorizonDays: 180,

  /** Broad seasonal trend — multiplier per calendar month (Jan..Dec), around 1.0.
   *  Sensitivity scales the swing (PriceLabs presets); "recommended" = as-is. */
  seasonality: {
    enabled: true,
    sensitivity: "recommended",
    monthlyIndex: [0.92, 0.93, 0.98, 1.05, 1.08, 1.06, 1.1, 1.12, 1.07, 1.02, 0.95, 1.0],
  },
  /** Date-specific demand (events, holidays, neighborhood heat). */
  demandEvents: {
    enabled: true,
    sensitivity: "recommended",
    /** Max ± fraction a demand spike can move price. */
    cap: 0.15,
  },
  /** Booking pace vs the unit's seasonal norm (ahead ⇒ premium, behind ⇒ discount). */
  pacing: {
    enabled: true,
    sensitivity: 0.1,
    cap: 0.1,
  },
  /** Occupancy-based adjustments (PriceLabs OBA) — the operator runs the
   *  Aggressive profile (−30%..+20% over the first 60 days). */
  occupancy: {
    enabled: true,
    profile: "aggressive",
    customName: null,
    windows: OBA_PRESETS.aggressive,
  },
  /** Far-out premium: distant dates earn a gradual uplift (protects future inventory). */
  farOut: {
    enabled: true,
    mode: "gradual",
    marketFlavor: "balanced",
    thresholdDays: 60,
    cap: 0.08,
    rampDays: 120,
  },
  /** Last-minute discount — OFF for MTR (long stays aren't discounted for near
   *  arrival). Shape mirrors the PriceLabs default: gradual 30% over 15 days. */
  lastMinute: {
    enabled: false,
    mode: "gradual",
    marketFlavor: "balanced",
    windowDays: 15,
    value: -0.3,
  },
  /** Adjacent factor (PriceLabs): adjust the open days right before/after a
   *  booking — discount to fill gaps, premium to discourage back-to-back
   *  turnovers. Stacks with last-minute per PriceLabs rules (largest discount
   *  wins; premiums stack). OFF for MTR: month-boundary gaps are rare. */
  adjacent: {
    enabled: true,
    mode: "percent",
    value: -0.3,
    daysBefore: 2,
    daysAfter: 2,
    applyOnWeekends: true,
  },
  /** Day-of-week multiplier — OFF for MTR (a multi-week stay spans every weekday).
   *  Index Sun=0 .. Sat=6 (TLV weekend = Fri/Sat). */
  dayOfWeek: {
    enabled: false,
    multiplier: [1, 1, 1, 1, 1, 1, 1],
  },
  /** Length-of-stay discounts. Weekly/monthly come from the unit (null here);
   *  the quarterly tier ships as a LOS tier row; more rows are operator-added. */
  los: {
    enabled: true,
    weeklyPct: null,
    monthlyPct: null,
    quarterlyMinNights: 90,
    quarterlyDiscountPct: 0.25,
    tiers: [],
  },
  /** Flat monthly leases regardless of headcount are the MTR norm — ships off. */
  extraPersonFee: {
    enabled: false,
    mode: "fixed",
    value: 0,
    afterGuests: 2,
  },
  /** No restriction until a profile is attached or days are narrowed. */
  checkinCheckout: {
    enabled: false,
    profile: null,
    allowedCheckin: [0, 1, 2, 3, 4, 5, 6],
    allowedCheckout: [0, 1, 2, 3, 4, 5, 6],
    lastMinute: [],
    smart: { blockGapCreating: false, maxGapNights: 1, beyondDays: 30, allowAdjacent: false },
  },
  /** Matches the engine's historical ₪5 step (digits=1, endings 0/5). */
  rounding: { enabled: true, digits: 1, endings: [0, 5] },
  smoothing: { enabled: false, mode: "week", weekStart: 5 },
  /** ON: cancel-and-rebook-cheaper protection matters for long stays. */
  freezeUnavailable: { enabled: true },
  neighborhoodProfile: { source: null },
  /** PriceLabs ships this on; inert without reservation data. */
  bookingRecency: { enabled: true },
  seasonalProfile: { enabled: false, profile: null, mode: "fixed", seasons: [] },
  /** Pricing offset (PriceLabs): a final fixed/percent nudge applied AFTER all
   *  other customizations — including the floor/ceiling clamp and fixed-price
   *  overrides — so it can take the pushed rate outside the unit's min/max.
   *  Channel-fee parity tool; OFF by default. */
  pricingOffset: {
    enabled: false,
    mode: "percent",
    value: 0,
  },
  /** Operator's weekend definition: Thursday + Friday nights. */
  weekend: { days: [4, 5] },
  /** Operator default: 40% discount on 3–7-night gaps, any lead time. */
  orphanDayPrices: {
    enabled: true,
    ranges: [
      { fromGapNights: 3, upToGapNights: 7, mode: "percent", weekday: -0.4, weekend: -0.4, withinDays: null },
    ],
  },
  /** Needs customization groups to mean anything (single units swing 0↔100%). */
  portfolioOccupancy: {
    enabled: false,
    profile: "long",
    windows: PORTFOLIO_OBA_PRESETS.long,
  },
  minPrices: {
    farOut: { enabled: false, beyondDays: 60, mode: "pctBase", value: 0 },
    weekend: { enabled: false, mode: "pctBase", value: 0 },
    lastMinute: { enabled: false, withinDays: 14, mode: "pctMin", value: 0 },
    orphan: { enabled: false, mode: "pctMin", value: 0 },
  },
  /** PriceLabs ships SMP on by default; ~110% is their "safe choice". Inert
   *  until reservation history exists. */
  safetyMinPrice: { enabled: true, pctOfLastYear: 1.1 },
  /** Operator's live setup: custom 3/3 default, a far-out ladder stepping
   *  4→28 nights with lead time, gap−1 orphan fills on 4–28-night gaps, and
   *  7-night stays within 2 days after an unavailable night (lead 7–30d). */
  minStayRules: {
    profile: null,
    mode: "custom",
    recommendedFlavor: "mtr",
    highestAllowed: 90,
    custom: { rule: "fixed", weekday: 3, weekend: 3, bookingValue: 0 },
    lastMinute: [],
    farOut: [
      { beyondDays: 2, weekday: 4, weekend: 4 },
      { beyondDays: 4, weekday: 7, weekend: 7 },
      { beyondDays: 7, weekday: 14, weekend: 14 },
      { beyondDays: 14, weekday: 21, weekend: 21 },
      { beyondDays: 20, weekday: 28, weekend: 28 },
    ],
    adjacent: {
      enabled: true,
      afterNights: 7,
      afterWithinDays: 2,
      afterLeadFromDays: 7,
      afterLeadToDays: 30,
      beforeFlushFit: false,
    },
    orphanGap: { enabled: true, strategy: "gapMinus1", fixedNights: 1, minGapNights: 4, maxGapNights: 28, lowestAllowed: 1 },
    adaptiveOccupancy: { enabled: true },
  },
  /** Minimum-stay hierarchy extras (the demand-flex tiers live in PRICING_AGENT). */
  minStayHierarchy: {
    /** Beyond this lead-time, require a longer commitment. */
    farOutThresholdDays: 90,
    farOutNights: 60,
  },
};

