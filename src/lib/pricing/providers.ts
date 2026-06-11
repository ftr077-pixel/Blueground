// Market data providers for the pricing rule engine.
//
// The engine depends ONLY on this interface, never on a concrete data source.
// `mockProviders()` supplies deterministic, demo-quality signals today; to go
// live, implement `MarketProviders` against your real sources (PMS calendar,
// events feed, the visibility scraper, etc.) and pass it to runPricingPass /
// the engine. Each method below carries a "PRODUCTION SEAM" note describing the
// real input. Comp-set min-nights is ALREADY wired to live scraper data.

import { listUnits, type Unit } from "@/lib/repos/units";
import { marketMinNightsBenchmark } from "@/lib/repos/visibility";
import { bookedDatesForUnit } from "@/lib/repos/rates";
import { listMarketSnapshots, type MarketSnapshot, type PacingPoint } from "@/lib/repos/market";

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

  /** True when the unit's calendar shows a confirmed booking on this night.
   *  Feeds the Adjacent Factor and orphan-gap rules. Wired to the Rates
   *  Calendar's booked cells (MiniHotel actuals + baseline blocks);
   *  closed-only nights don't count. */
  isBooked(unit: Unit, date: Date): boolean;

  /** Combined occupancy of the unit's customization group for a date (booked
   *  members ÷ members), or null when the unit has no group / the group has
   *  fewer than 2 members. Feeds Portfolio Occupancy-Based Adjustments. */
  groupOccupancy(unit: Unit, date: Date): number | null;

  /** Own vs market forward occupancy over the next ~90 nights, or null when
   *  the market side is unknown. Feeds the Adaptive Occupancy min-stay
   *  reduction (own running relatively below market ⇒ shorter min stay). */
  occupancy90(unit: Unit): { own: number; market: number } | null;

  /** Operator/calendar override for a unit+date, or null.
   *  PRODUCTION SEAM: a unit_date_overrides table edited by the operator. */
  dateOverride(unit: Unit, date: Date): DateOverride | null;
}

// Shared calendar-derived signals: per provider instance, lazily loads each
// unit's booked set once (spanning 31 days back — the adjacency scan can look
// up to 30 days behind a quoted night — through the 1-year preview horizon),
// and derives group occupancy + own forward occupancy from the same sets.
function calendarSignals(marketOcc90: (unit: Unit) => number | null) {
  const DAY = 86_400_000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const todayIso = iso(new Date());
  const start = iso(new Date(Date.now() - 31 * DAY));
  const sets = new Map<string, Set<string>>();
  const setFor = (id: string) => {
    let s = sets.get(id);
    if (!s) {
      s = bookedDatesForUnit(id, start, 430);
      sets.set(id, s);
    }
    return s;
  };
  let unitsCache: Unit[] | null = null;
  const allUnits = () => (unitsCache ??= listUnits());
  const groupOccCache = new Map<string, number | null>();

  return {
    isBooked(unit: Unit, date: Date): boolean {
      return setFor(unit.id).has(iso(date));
    },
    groupOccupancy(unit: Unit, date: Date): number | null {
      const g = unit.group;
      if (!g) return null;
      const key = g + "|" + iso(date);
      const hit = groupOccCache.get(key);
      if (hit !== undefined) return hit;
      // A group customization counts listings attached as group OR sub-group.
      const members = allUnits().filter((u) => u.group === g || u.subgroup === g);
      const occ =
        members.length < 2
          ? null
          : members.filter((u) => setFor(u.id).has(iso(date))).length / members.length;
      groupOccCache.set(key, occ);
      return occ;
    },
    occupancy90(unit: Unit): { own: number; market: number } | null {
      const market = marketOcc90(unit);
      if (market == null || market <= 0) return null;
      const s = setFor(unit.id);
      let own = 0;
      const t0 = Date.parse(todayIso + "T00:00:00Z");
      for (let i = 0; i < 90; i++) {
        if (s.has(new Date(t0 + i * DAY).toISOString().slice(0, 10))) own++;
      }
      return { own: own / 90, market };
    },
  };
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
  const signals = calendarSignals(() => 0.85); // market norm
  return {
    ...signals,
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

// --------------------------------------------------------------------------
// AirROI-backed providers: map cached market_snapshots (refreshed by the daily
// sync) onto the engine's MarketProviders. Each method draws on a *distinct*
// AirROI signal so the rule stack doesn't double-count the same data:
//   occupancy   ← forward pacing fill_rate (by date)
//   seasonality ← forward booked-rate curve (rate seasonality)
//   pacing      ← near-term vs window fill velocity
//   demand      ← small fill-vs-average nudge (also flexes min-stay)
//   min-stay    ← real market min-nights (AirROI summary, scraper as fallback)
// --------------------------------------------------------------------------
interface Prepped {
  snap: MarketSnapshot;
  pacingByDate: Map<string, PacingPoint>;
  meanFill: number;
  nearMeanFill: number;
  meanBookedRate: number;
}

const dkey = (d: Date) => d.toISOString().slice(0, 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function prep(snap: MarketSnapshot): Prepped {
  const pacing = snap.pacing ?? [];
  const fills = pacing.map((p) => p.fill_rate).filter((x) => x > 0);
  const near = pacing.slice(0, 30).map((p) => p.fill_rate).filter((x) => x > 0);
  const rates = pacing.map((p) => p.booked_rate_avg).filter((x) => x > 0);
  return {
    snap,
    pacingByDate: new Map(pacing.map((p) => [p.date, p])),
    meanFill: mean(fills),
    nearMeanFill: mean(near.length ? near : fills),
    meanBookedRate: mean(rates),
  };
}

export function airRoiProviders(): MarketProviders {
  const prepped = new Map<string, Prepped>();
  for (const s of listMarketSnapshots()) prepped.set(s.neighborhood, prep(s));

  const summaries = [...prepped.values()]
    .map((p) => p.snap.summary)
    .filter((s): s is NonNullable<MarketSnapshot["summary"]> => !!s);
  const globalOcc = summaries.length ? mean(summaries.map((s) => s.occupancy)) : 0.85;
  const globalMinNights = summaries.length ? Math.round(mean(summaries.map((s) => s.min_nights))) : null;
  const scraperMedian = marketMinNightsBenchmark().median;
  const signals = calendarSignals(
    (unit) => prepped.get(unit.neighborhood)?.snap.summary?.occupancy ?? globalOcc,
  );

  return {
    ...signals,
    seasonalityIndex(date) {
      const ratios: number[] = [];
      for (const p of prepped.values()) {
        const pt = p.pacingByDate.get(dkey(date));
        if (pt && p.meanBookedRate > 0 && pt.booked_rate_avg > 0) {
          ratios.push(pt.booked_rate_avg / p.meanBookedRate);
        }
      }
      return ratios.length ? clamp(mean(ratios), 0.85, 1.15) : null;
    },
    eventDemand(unit, date) {
      const p = prepped.get(unit.neighborhood);
      const pt = p?.pacingByDate.get(dkey(date));
      if (p && pt && p.meanFill > 0) {
        return {
          bump: clamp(pt.fill_rate - p.meanFill, -0.05, 0.05),
          driver: `AirROI ${p.snap.marketName ?? unit.neighborhood}: fill ${(pt.fill_rate * 100).toFixed(0)}% vs ${(p.meanFill * 100).toFixed(0)}% avg`,
        };
      }
      return { bump: 0, driver: "AirROI market data" };
    },
    pacing(unit) {
      const p = prepped.get(unit.neighborhood);
      if (p && p.meanFill > 0) return clamp((p.nearMeanFill - p.meanFill) / p.meanFill, -1, 1);
      return 0;
    },
    occupancy(unit, date) {
      const p = prepped.get(unit.neighborhood);
      const pt = p?.pacingByDate.get(dkey(date));
      if (pt && pt.fill_rate > 0) return pt.fill_rate;
      if (p?.snap.summary) return p.snap.summary.occupancy;
      return globalOcc;
    },
    compMedianMinNights() {
      return globalMinNights ?? scraperMedian;
    },
    dateOverride() {
      return null;
    },
  };
}

/** Pick the live provider when market data has been synced, else the mock. */
export function marketProviders(): MarketProviders {
  return listMarketSnapshots().length > 0 ? airRoiProviders() : mockProviders();
}
