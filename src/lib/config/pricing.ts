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
  /** Price floor as a fraction of base rate (PriceLabs "min price"). */
  floorPctOfBase: 0.8,
  /** Price ceiling as a fraction of base rate (surge cap). */
  ceilingPctOfBase: 1.2,
  /** Weekly LOS discount (0..1). */
  weeklyDiscountPct: 0.1,
  /** Monthly LOS discount (0..1) — the headline mid-term lever. */
  monthlyDiscountPct: 0.2,
  /** Recommended minimum stay, nights (the agent flexes this with demand). */
  minStay: 30,
  /** Hard minimum-stay floor, nights — what makes a unit mid-term. */
  lowestMinStay: 30,
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
 *  operator overrides (Settings → Pricing engine rules) are deep-merged over
 *  them at read time via src/lib/pricing/rules-config.ts. */
export interface PricingRulesConfig {
  currentRateLeadDays: number;
  curveHorizonDays: number;
  seasonality: { enabled: boolean; sensitivity: SeasonalitySensitivity; monthlyIndex: number[] };
  demandEvents: { enabled: boolean; cap: number };
  pacing: { enabled: boolean; sensitivity: number; cap: number };
  occupancy: { enabled: boolean; bands: OccupancyBand[] };
  farOut: { enabled: boolean; thresholdDays: number; cap: number; rampDays: number };
  lastMinute: { enabled: boolean; windowDays: number; maxDiscount: number };
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
  los: { enabled: boolean; quarterlyMinNights: number; quarterlyDiscountPct: number };
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
  /** Dynamic Minimum Stay restrictions (full PriceLabs hierarchy; resolution
   *  order lives in engine.resolveMinStay). MiniHotel's MinimumNights field is
   *  min-stay-THROUGH semantics. */
  minStayRules: {
    /** recommended = engine-driven (demand tiers + market median); custom = the rules below. */
    mode: "recommended" | "custom";
    /** Highest Minimum Stay Allowed — recommendations never exceed this. */
    highestAllowed: number;
    /** Custom default rule: fixed weekday/weekend nights, or a min booking value
     *  (₪) the stay must gross (nights ≈ value ÷ nightly rate). */
    custom: { rule: "fixed" | "bookingValue"; weekday: number; weekend: number; bookingValue: number };
    /** Up to 3 last-minute rules: lower the min stay near check-in. */
    lastMinute: Array<{ withinDays: number; weekday: number; weekend: number }>;
    /** Adjacent-day min stays: allow shorter stays that butt up against an
     *  existing booking. after = night right after a checkout; before = stays
     *  that end flush against the next booking (no gap created). */
    adjacent: { enabled: boolean; afterNights: number; beforeFlushFit: boolean };
    /** Orphan-gap min stay: shrink the min stay to make short gaps bookable.
     *  Only ever REDUCES (PriceLabs rule), with its own floor (Lowest Orphan
     *  Gap Allowed — may sit below the unit's lowestMinStay). */
    orphanGap: {
      enabled: boolean;
      strategy: "lengthOfGap" | "gapMinus1" | "gapMinus2" | "fixed";
      fixedNights: number;
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
    /** Max ± fraction a demand spike can move price. */
    cap: 0.15,
  },
  /** Booking pace vs the unit's seasonal norm (ahead ⇒ premium, behind ⇒ discount). */
  pacing: {
    enabled: true,
    sensitivity: 0.1,
    cap: 0.1,
  },
  /** Occupancy-based adjustment bands (PriceLabs OBA). */
  occupancy: {
    enabled: true,
    bands: [
      { upTo: 0.5, adjust: -0.05, label: "soft <50%" },
      { upTo: 0.8, adjust: 0.0, label: "healthy 50–80%" },
      { upTo: 0.95, adjust: 0.05, label: "tight 80–95%" },
      { upTo: 1.01, adjust: 0.1, label: "full 95%+" },
    ] as OccupancyBand[],
  },
  /** Far-out premium: distant dates earn a gradual uplift (protects future inventory). */
  farOut: {
    enabled: true,
    thresholdDays: 60,
    cap: 0.08,
    rampDays: 120,
  },
  /** Last-minute discount — OFF for MTR (long stays aren't discounted for near arrival). */
  lastMinute: {
    enabled: false,
    windowDays: 14,
    maxDiscount: 0.15,
  },
  /** Adjacent factor (PriceLabs): adjust the open days right before/after a
   *  booking — discount to fill gaps, premium to discourage back-to-back
   *  turnovers. Stacks with last-minute per PriceLabs rules (largest discount
   *  wins; premiums stack). OFF for MTR: month-boundary gaps are rare. */
  adjacent: {
    enabled: false,
    mode: "percent",
    value: -0.1,
    daysBefore: 2,
    daysAfter: 2,
    applyOnWeekends: false,
  },
  /** Day-of-week multiplier — OFF for MTR (a multi-week stay spans every weekday).
   *  Index Sun=0 .. Sat=6 (TLV weekend = Fri/Sat). */
  dayOfWeek: {
    enabled: false,
    multiplier: [1, 1, 1, 1, 1, 1, 1],
  },
  /** Length-of-stay discounts. Weekly/monthly come from the unit; this adds a
   *  longer-stay tier on top. */
  los: {
    enabled: true,
    quarterlyMinNights: 90,
    quarterlyDiscountPct: 0.25,
  },
  /** Pricing offset (PriceLabs): a final fixed/percent nudge applied AFTER all
   *  other customizations — including the floor/ceiling clamp and fixed-price
   *  overrides — so it can take the pushed rate outside the unit's min/max.
   *  Channel-fee parity tool; OFF by default. */
  pricingOffset: {
    enabled: false,
    mode: "percent",
    value: 0,
  },
  /** TLV weekend: Friday + Saturday nights. */
  weekend: { days: [5, 6] },
  /** PriceLabs ships this ON with a 20% discount on ≤2-night gaps; for a 30+
   *  night portfolio orphan gaps are rare, so it ships implemented but OFF. */
  orphanDayPrices: {
    enabled: false,
    ranges: [{ upToGapNights: 2, mode: "percent", weekday: -0.2, weekend: -0.2, withinDays: null }],
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
  minStayRules: {
    mode: "recommended",
    highestAllowed: 90,
    custom: { rule: "fixed", weekday: 30, weekend: 30, bookingValue: 0 },
    lastMinute: [],
    adjacent: { enabled: false, afterNights: 30, beforeFlushFit: false },
    orphanGap: { enabled: false, strategy: "lengthOfGap", fixedNights: 1, maxGapNights: 4, lowestAllowed: 1 },
    adaptiveOccupancy: { enabled: true },
  },
  /** Minimum-stay hierarchy extras (the demand-flex tiers live in PRICING_AGENT). */
  minStayHierarchy: {
    /** Beyond this lead-time, require a longer commitment. */
    farOutThresholdDays: 90,
    farOutNights: 60,
  },
};

