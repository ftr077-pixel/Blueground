// Market data providers for the pricing rule engine.
//
// The engine depends ONLY on this interface, never on a concrete data source.
// `mockProviders()` supplies deterministic, demo-quality signals today; to go
// live, implement `MarketProviders` against your real sources (PMS calendar,
// events feed, the visibility scraper, etc.) and pass it to runPricingPass /
// the engine. Each method below carries a "PRODUCTION SEAM" note describing the
// real input. Comp-set min-nights is ALREADY wired to live scraper data.

import type { Unit } from "@/lib/repos/units";
import { marketMinNightsBenchmark } from "@/lib/repos/visibility";

export interface DateOverride {
  /** Absolute nightly rate to pin for this date (skips dynamic rules), or undefined. */
  rate?: number;
  /** Absolute minimum stay (nights) for this date, or undefined. */
  minStay?: number;
  note?: string;
}

export interface MarketProviders {
  /** Live market seasonality multiplier (~1.0) for a date, or null to fall back
   *  to the configured monthly curve.
   *  PRODUCTION SEAM: derive from market dashboard / historical ADR by season. */
  seasonalityIndex(date: Date): number | null;

  /** Date-specific demand as a signed fraction (+0.12 = 12% hotter) plus a driver
   *  string for the audit trail.
   *  PRODUCTION SEAM: events calendar + comp-set pickup + search-volume signals. */
  eventDemand(unit: Unit, date: Date): { bump: number; driver: string };

  /** Booking pace vs the unit's seasonal norm, −1 (behind) .. +1 (ahead).
   *  PRODUCTION SEAM: PMS reservations vs last-year-as-of-today pickup curve. */
  pacing(unit: Unit): number;

  /** Forward occupancy 0..1 for a date.
   *  PRODUCTION SEAM: PMS calendar (booked nights / available) around the date. */
  occupancy(unit: Unit, date: Date): number;

  /** Median competitor minimum-stay (nights), or null. Wired to live scraper data. */
  compMedianMinNights(): number | null;

  /** Operator/calendar override for a unit+date, or null.
   *  PRODUCTION SEAM: a unit_date_overrides table edited by the operator. */
  dateOverride(unit: Unit, date: Date): DateOverride | null;
}

// 0..1 deterministic noise so demo signals are stable within a day.
function noise(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function dayKey(date: Date): number {
  return date.getUTCFullYear() * 1000 + date.getUTCMonth() * 50 + date.getUTCDate();
}

// Per-neighborhood demand flavor (ports the old defaultSignals character).
// Tuned so the rule stack lands across the floor/ceiling band with variety
// rather than saturating — real providers bring their own distribution.
const HOOD_DEMAND: Record<string, { base: number; driver: string }> = {
  "Lev HaIr": { base: 0.0, driver: "Steady weekday relocation demand." },
  "Neve Tzedek": { base: 0.08, driver: "DLD Festival week — comp set up ~14%." },
  Florentin: { base: -0.02, driver: "Comp set flat; long-stay leads soft." },
  "Kerem HaTeimanim": { base: 0.05, driver: "Heatwave forecast lifting inbound search." },
};

/** Deterministic, demo-quality providers. Swap for real implementations at go-live. */
export function mockProviders(): MarketProviders {
  const compMedian = marketMinNightsBenchmark().median;
  return {
    seasonalityIndex() {
      return null; // use the configured monthly curve
    },
    eventDemand(unit, date) {
      const hood = HOOD_DEMAND[unit.neighborhood] ?? { base: 0.0, driver: "Baseline demand." };
      const jitter = (noise(dayKey(date) + unit.neighborhood.length) - 0.5) * 0.1;
      return { bump: hood.base + jitter, driver: hood.driver };
    },
    pacing(unit) {
      // Behind/ahead proxied from 30-day occupancy vs an 85% norm, in −1..+1.
      return Math.max(-1, Math.min(1, (unit.occupancy30d - 0.85) * 3));
    },
    occupancy(unit) {
      return unit.occupancy30d; // mock: flat across dates
    },
    compMedianMinNights() {
      return compMedian;
    },
    dateOverride() {
      return null;
    },
  };
}
