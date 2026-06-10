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

/** The full rule-engine configuration. Code defaults live in PRICING_RULES;
 *  operator overrides (Settings → Pricing engine rules) are deep-merged over
 *  them at read time via src/lib/pricing/rules-config.ts. */
export interface PricingRulesConfig {
  currentRateLeadDays: number;
  curveHorizonDays: number;
  seasonality: { enabled: boolean; monthlyIndex: number[] };
  demandEvents: { enabled: boolean; cap: number };
  pacing: { enabled: boolean; sensitivity: number; cap: number };
  occupancy: { enabled: boolean; bands: OccupancyBand[] };
  farOut: { enabled: boolean; thresholdDays: number; cap: number; rampDays: number };
  lastMinute: { enabled: boolean; windowDays: number; maxDiscount: number };
  dayOfWeek: { enabled: boolean; multiplier: number[] };
  los: { enabled: boolean; quarterlyMinNights: number; quarterlyDiscountPct: number };
  minStayHierarchy: { farOutThresholdDays: number; farOutNights: number };
}

export const PRICING_RULES: PricingRulesConfig = {
  /** Lead-time (days out) at which the headline "current rate" is quoted. 0 = price
   *  as-of-now (intuitive headline); the forward view, incl. far-out premiums, is
   *  in the price curve. Raise it to price a typical booking window instead. */
  currentRateLeadDays: 0,
  /** Horizon (days) for the per-date price curve. */
  curveHorizonDays: 180,

  /** Broad seasonal trend — multiplier per calendar month (Jan..Dec), around 1.0. */
  seasonality: {
    enabled: true,
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
  /** Minimum-stay hierarchy extras (the demand-flex tiers live in PRICING_AGENT). */
  minStayHierarchy: {
    /** Beyond this lead-time, require a longer commitment. */
    farOutThresholdDays: 90,
    farOutNights: 60,
  },
};

