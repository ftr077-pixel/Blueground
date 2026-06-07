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
