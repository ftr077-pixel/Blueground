// The pricing rule set. Each rule is a pure function that, given the context,
// returns a multiplicative factor on the base rate plus a human-readable reason
// (or null when it doesn't apply / is disabled). The engine runs them in order
// and records every applied factor for a full audit trail.

import type { Unit } from "@/lib/repos/units";
import {
  PRICING_RULES,
  SEASONALITY_SENSITIVITY,
  PRICING_OFFSET_LIMITS,
  MARKET_FLAVOR_MULT,
} from "@/lib/config/pricing";
import type { MarketProviders } from "@/lib/pricing/providers";

export interface FactorResult {
  key: string;
  label: string;
  /** Multiplier on the running rate (1.0 = no change). */
  factor: number;
  /** Optional ₪ additive (fixed-mode adjustments), applied after all multipliers. */
  add?: number;
  /** Optional absolute nightly price pin (e.g. fixed orphan-day price): the
   *  engine sets the pre-clamp raw rate to this, ignoring factor/add. */
  pin?: number;
  detail: string;
}

type Rules = typeof PRICING_RULES;

const DAY_MS = 86_400_000;
const clampDev = (factor: number, cap: number) => Math.max(1 - cap, Math.min(1 + cap, factor));
const pct = (f: number) => `${f >= 1 ? "+" : ""}${((f - 1) * 100).toFixed(1)}%`;
const shiftDay = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function seasonalityRule(date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.seasonality.enabled) return null;
  const sens =
    SEASONALITY_SENSITIVITY[cfg.seasonality.sensitivity] ?? SEASONALITY_SENSITIVITY.recommended;
  if (sens.amplitude === 0) return null; // "No Seasonality"
  const idx = m.seasonalityIndex(date) ?? cfg.seasonality.monthlyIndex[date.getUTCMonth()];
  const factor = 1 + (idx - 1) * sens.amplitude;
  if (factor === 1) return null;
  const sensTxt =
    cfg.seasonality.sensitivity === "recommended" ? "" : ` (${sens.label.toLowerCase()})`;
  return {
    key: "seasonality",
    label: "Seasonality",
    factor,
    detail: `${MONTHS[date.getUTCMonth()]} season ${pct(factor)}${sensTxt}`,
  };
}

export function demandRule(unit: Unit, date: Date, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.demandEvents.enabled) return null;
  const sens =
    SEASONALITY_SENSITIVITY[cfg.demandEvents.sensitivity] ?? SEASONALITY_SENSITIVITY.recommended;
  if (sens.amplitude === 0) return null; // "No Demand Factor"
  const { bump, driver } = m.eventDemand(unit, date);
  const factor = clampDev(1 + bump * sens.amplitude, cfg.demandEvents.cap);
  if (factor === 1) return null;
  const sensTxt =
    cfg.demandEvents.sensitivity === "recommended" ? "" : ` (${sens.label.toLowerCase()})`;
  return { key: "demand", label: "Demand/events", factor, detail: `${pct(factor)} — ${driver}${sensTxt}` };
}

export function pacingRule(unit: Unit, m: MarketProviders, cfg: Rules): FactorResult | null {
  if (!cfg.pacing.enabled) return null;
  const pace = m.pacing(unit); // -1..+1
  const factor = clampDev(1 + pace * cfg.pacing.sensitivity, cfg.pacing.cap);
  if (factor === 1) return null;
  const word = pace >= 0 ? "ahead of" : "behind";
  return { key: "pacing", label: "Booking pace", factor, detail: `${pct(factor)} — pacing ${word} norm` };
}

/** Occupancy-Based Adjustments: the listing's OWN occupancy over the booking
 *  window containing this date drives the window's band matrix ("3 booked of
 *  15 nights ⇒ 20% ⇒ discount the remaining open days"). marketDriven compares
 *  own vs market occupancy for the next 60 days (discount ≤20%, premium ≤15% —
 *  PriceLabs's documented caps). Fixed-price pins bypass it in the engine. */
export function occupancyRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.occupancy;
  if (!c.enabled) return null;
  if (c.profile === "marketDriven") {
    if (leadDays > 60) return null;
    const market = m.occupancy90(unit)?.market;
    if (market == null || market <= 0) return null;
    const own = m.windowOccupancy(unit, 0, 60);
    const adjust = Math.max(-0.2, Math.min(0.15, (own - market) * 0.75));
    if (Math.abs(adjust) < 0.005) return null;
    return {
      key: "occupancy",
      label: "Occupancy",
      factor: 1 + adjust,
      detail: `own ${(own * 100).toFixed(0)}% vs market ${(market * 100).toFixed(0)}% ${pct(1 + adjust)} (market-driven)`,
    };
  }
  if (c.windows.length === 0) return null;
  let lo = 0;
  let win = c.windows[c.windows.length - 1];
  for (const w of c.windows) {
    if (leadDays <= w.uptoDays) {
      win = w;
      break;
    }
    lo = w.uptoDays + 1;
  }
  const hi = win.uptoDays >= 9999 ? Math.max(lo + 30, 180) : win.uptoDays;
  const occ = m.windowOccupancy(unit, lo, hi);
  const band = win.bands.find((b) => occ < b.upTo) ?? win.bands[win.bands.length - 1];
  const adjust = Math.max(-0.5, Math.min(5, band.adjust));
  if (adjust === 0) return null;
  return {
    key: "occupancy",
    label: "Occupancy",
    factor: 1 + adjust,
    detail: `${(occ * 100).toFixed(0)}% booked in the ${lo}–${win.uptoDays >= 9999 ? "…" : win.uptoDays}d window ${pct(1 + adjust)}`,
  };
}

/** Booking Recency Factor: an automatic temporary discount for listings going
 *  cold — no live booking in 15+ days, fresh reservation data (<3 days), and
 *  next-30d occupancy under 10% (or under 80% of market and below 70%).
 *  Linear 5% → 15% over 15 → 45 days since the last booking, applied to the
 *  next 30 days only; a plain pre-clamp factor, so the minimum price holds.
 *  Blocks count as bookings in the occupancy check (windowOccupancy). */
export function bookingRecencyRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  if (!cfg.bookingRecency.enabled || leadDays > 30) return null;
  const sig = m.bookingRecency(unit);
  if (!sig || sig.feedAgeDays >= 3 || sig.lastBookedDaysAgo < 15) return null;
  const lo = m.windowOccupancy(unit, 0, 29);
  const market = m.occupancy90(unit)?.market ?? null;
  const cold = lo < 0.1 || (market != null && lo < 0.8 * market && lo < 0.7);
  if (!cold) return null;
  const depth = Math.min(0.15, 0.05 + (Math.max(0, sig.lastBookedDaysAgo - 15) / 30) * 0.1);
  return {
    key: "bookingRecency",
    label: "Booking recency",
    factor: 1 - depth,
    detail: `${pct(1 - depth)} — no booking in ${Math.round(Math.min(sig.lastBookedDaysAgo, 999))}d, next-30d occ ${(lo * 100).toFixed(0)}%`,
  };
}

/** Rounding preference: snap `value`'s trailing `digits` digits to the nearest
 *  allowed ending (e.g. digits=1 endings=[4,9]: 2823 → 2824; digits=2
 *  endings=[0,50]: 178 → 200/150 whichever is nearer). */
export function roundToPreference(value: number, digits: number, endings: number[]): number {
  const d = Math.max(1, Math.min(5, Math.round(digits)));
  const mod = 10 ** d;
  const base = Math.floor(value / mod) * mod;
  let best = Math.round(value);
  let bestDist = Infinity;
  for (const raw of endings) {
    const e = Math.abs(Math.round(raw)) % mod;
    for (const cand of [base - mod + e, base + e, base + mod + e]) {
      if (cand <= 0) continue;
      const dist = Math.abs(cand - value);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }
  return best;
}

/** Far Out Prices: gradual ramp (default), flat beyond the threshold, or
 *  market-driven — a flavored 20%-capped ramp starting no earlier than 60 days
 *  out (PriceLabs's documented limits), modulated by the market's fill for the
 *  date where known (hot far dates hold firmer). */
export function farOutRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.farOut;
  if (!c.enabled) return null;
  if (c.mode === "marketDriven") {
    const threshold = Math.max(60, c.thresholdDays);
    if (leadDays <= threshold) return null;
    const ramp = Math.min(1, (leadDays - threshold) / 210); // the PL-determined ~7-month ramp
    const fill = m.occupancy(unit, date);
    const heat = fill > 0 ? Math.max(0.75, Math.min(1.25, 0.75 + 0.5 * fill)) : 1;
    const premium = Math.min(0.2, MARKET_FLAVOR_MULT[c.marketFlavor] * ramp * 0.2 * heat);
    if (premium <= 0) return null;
    return {
      key: "farOut",
      label: "Far-out premium",
      factor: 1 + premium,
      detail: `${leadDays}d out ${pct(1 + premium)} — market-driven (${c.marketFlavor})`,
    };
  }
  if (leadDays <= c.thresholdDays) return null;
  const factor =
    c.mode === "flat"
      ? 1 + c.cap
      : 1 + Math.min(1, (leadDays - c.thresholdDays) / c.rampDays) * c.cap;
  if (factor === 1) return null;
  return {
    key: "farOut",
    label: c.cap >= 0 ? "Far-out premium" : "Far-out discount",
    factor,
    detail: `${leadDays}d out ${pct(factor)}${c.mode === "flat" ? " (flat)" : ""}`,
  };
}

/** Last Minute Prices: gradual (default), % flat, fixed nightly price (returned
 *  as a pin — beats an orphan-day fixed price per the PriceLabs fixed-override
 *  hierarchy), or market-driven (flavored; deeper when the market's fill for
 *  the date is soft). Custom windows cap at 90 days. */
export function lastMinuteRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.lastMinute;
  const window = Math.min(90, c.windowDays);
  if (!c.enabled || window <= 0 || leadDays > window) return null;
  if (c.mode === "fixed") {
    if (c.value <= 0) return null;
    return {
      key: "lastMinute",
      label: "Last-minute",
      factor: 1,
      pin: c.value,
      detail: `${leadDays}d out — fixed ₪${c.value}`,
    };
  }
  if (c.mode === "flat") {
    if (c.value === 0) return null;
    return {
      key: "lastMinute",
      label: "Last-minute",
      factor: 1 + c.value,
      detail: `${leadDays}d out ${pct(1 + c.value)} (flat)`,
    };
  }
  const closeness = (window - leadDays) / window;
  if (c.mode === "marketDriven") {
    const fill = m.occupancy(unit, date);
    const softness = fill > 0 ? Math.max(0.6, Math.min(1.4, 0.6 + 0.8 * (1 - fill))) : 1;
    const depth = Math.min(0.6, MARKET_FLAVOR_MULT[c.marketFlavor] * closeness * 0.3 * softness);
    if (depth <= 0) return null;
    return {
      key: "lastMinute",
      label: "Last-minute",
      factor: 1 - depth,
      detail: `${leadDays}d out ${pct(1 - depth)} — market-driven (${c.marketFlavor})`,
    };
  }
  const factor = 1 + closeness * c.value; // gradual ramp toward the full value at day 0
  if (factor === 1) return null;
  return { key: "lastMinute", label: "Last-minute", factor, detail: `${leadDays}d out ${pct(factor)}` };
}

/** Extra Person Fee for a quoted night: per extra guest above the threshold.
 *  Percent mode prices off the CHECK-IN day's rate only (PriceLabs sends no
 *  per-night variation), so callers pass the check-in night's rate. */
export function extraPersonFee(
  rate: number,
  guests: number,
  cfg: Rules,
): { extraGuests: number; perGuest: number; total: number } | null {
  const c = cfg.extraPersonFee;
  if (!c.enabled || c.value <= 0 || guests <= c.afterGuests) return null;
  const perGuest = c.mode === "percent" ? Math.round(rate * c.value) : Math.round(c.value);
  if (perGuest <= 0) return null;
  const extraGuests = guests - c.afterGuests;
  return { extraGuests, perGuest, total: perGuest * extraGuests };
}

export function dayOfWeekRule(date: Date, cfg: Rules): FactorResult | null {
  if (!cfg.dayOfWeek.enabled) return null;
  const factor = cfg.dayOfWeek.multiplier[date.getUTCDay()];
  if (factor === 1) return null;
  return { key: "dayOfWeek", label: "Day-of-week", factor, detail: pct(factor) };
}

/** Does this date fall on a configured weekend day ("Weekend Days" customization)? */
export function isWeekendDay(date: Date, cfg: Rules): boolean {
  return cfg.weekend.days.includes(date.getUTCDay());
}

/** Orphan-gap detection: if `date` is an open night inside a short gap bounded
 *  by booked nights on BOTH sides (within `maxScan` days each way), returns the
 *  gap length in nights. Open calendar edges are not gaps. */
export function gapInfo(
  unit: Unit,
  date: Date,
  m: MarketProviders,
  maxScan = 45,
): { len: number } | null {
  if (m.isBooked(unit, date)) return null;
  let before = 0; // open nights strictly before `date` until the previous booking
  let found = false;
  for (let k = 1; k <= maxScan; k++) {
    if (m.isBooked(unit, shiftDay(date, -k))) {
      found = true;
      break;
    }
    before++;
  }
  if (!found) return null;
  let after = 0;
  found = false;
  for (let k = 1; k <= maxScan; k++) {
    if (m.isBooked(unit, shiftDay(date, k))) {
      found = true;
      break;
    }
    after++;
  }
  if (!found) return null;
  return { len: before + after + 1 };
}

/** PriceLabs "Orphan Day Prices": adjust (or pin) the price of short open gaps
 *  between bookings. First matching range wins (ranges are ascending by gap
 *  length). Percent entries join the last-minute/adjacent stacking rules; a
 *  fixed entry is an absolute nightly price the engine pins pre-clamp. */
export function orphanDayPriceRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.orphanDayPrices;
  if (!c.enabled || c.ranges.length === 0) return null;
  const gap = gapInfo(unit, date, m);
  if (!gap) return null;
  const range = c.ranges.find(
    (r) =>
      gap.len >= r.fromGapNights &&
      gap.len <= r.upToGapNights &&
      (r.withinDays == null || leadDays <= r.withinDays),
  );
  if (!range) return null;
  const value = isWeekendDay(date, cfg) ? range.weekend : range.weekday;
  if (range.mode === "fixed") {
    if (value <= 0) return null;
    return {
      key: "orphanDay",
      label: "Orphan day",
      factor: 1,
      pin: value,
      detail: `gap ${gap.len}n — fixed ₪${value}`,
    };
  }
  if (value === 0) return null;
  const word = value < 0 ? "discount" : "premium";
  return {
    key: "orphanDay",
    label: "Orphan day",
    factor: 1 + value,
    detail: `gap ${gap.len}n — ${pct(1 + value)} ${word}`,
  };
}

/** Portfolio Occupancy-Based Adjustments: price off the COMBINED occupancy of
 *  the unit's customization group, with a different band profile per
 *  booking-window column. Layered pre-clamp, so the unit's min/max still hold.
 *  No-op for ungrouped units (a single unit swings 0↔100%). */
export function portfolioOccupancyRule(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.portfolioOccupancy;
  if (!c.enabled || c.windows.length === 0) return null;
  const occ = m.groupOccupancy(unit, date);
  if (occ == null) return null;
  const win = c.windows.find((w) => leadDays <= w.uptoDays) ?? c.windows[c.windows.length - 1];
  const band = win.bands.find((b) => occ < b.upTo) ?? win.bands[win.bands.length - 1];
  const adjust = Math.max(-0.5, Math.min(5, band.adjust));
  if (adjust === 0) return null;
  return {
    key: "portfolioOccupancy",
    label: "Portfolio occupancy",
    factor: 1 + adjust,
    detail: `${unit.group}: ${(occ * 100).toFixed(0)}% booked ≤${win.uptoDays}d out ${pct(1 + adjust)}`,
  };
}

/** Advanced Minimum Price resolution for one night. farOut/weekend floors only
 *  ever RAISE the listing min (both can apply — the higher wins); last-minute
 *  and orphan floors REPLACE it, and may sit below the listing min (their
 *  documented purpose: looser floors where conversion matters most). */
export function resolveMinPrice(
  unit: Unit,
  date: Date,
  leadDays: number,
  m: MarketProviders,
  cfg: Rules,
): { min: number; source: string } {
  const c = cfg.minPrices;
  const compute = (mode: "fixed" | "pctBase" | "pctMin", value: number) =>
    mode === "fixed"
      ? value
      : mode === "pctBase"
        ? unit.baseRate * (1 + value)
        : unit.minRate * (1 + value);
  let min = unit.minRate;
  let source = "listing";
  if (c.farOut.enabled && leadDays >= c.farOut.beyondDays) {
    const v = compute(c.farOut.mode, c.farOut.value);
    if (v > min) {
      min = v;
      source = "far-out";
    }
  }
  if (c.weekend.enabled && isWeekendDay(date, cfg)) {
    const v = compute(c.weekend.mode, c.weekend.value);
    if (v > min) {
      min = v;
      source = source === "far-out" ? "far-out + weekend" : "weekend";
    }
  }
  // Safety Minimum Price: last year's realized rate for the same weekday
  // (STLY ±1 week, weighted toward STLY; event-hot dates take the range MAX),
  // times the inflation factor. Raises-only — never applies below the listing
  // min — and inert without reservation history (PriceLabs's PMS gating).
  const smp = cfg.safetyMinPrice;
  if (smp.enabled && smp.pctOfLastYear > 0) {
    const stly = date.getTime() - 364 * DAY_MS; // nearest same weekday last year
    const probe = (offDays: number) =>
      m.lastYearNightly(unit, new Date(stly + offDays * DAY_MS).toISOString().slice(0, 10));
    const center = probe(0);
    const before = probe(-7);
    const after = probe(7);
    const present = [center, before, after].filter((x): x is number => x != null && x > 0);
    if (present.length) {
      const hot = m.eventDemand(unit, date).bump >= 0.1; // events/holidays: take the max
      let anchor: number;
      if (hot) {
        anchor = Math.max(...present);
      } else {
        // Weighted average over the dates that HAVE data, STLY counting double.
        let sum = 0;
        let w = 0;
        if (center != null && center > 0) {
          sum += 2 * center;
          w += 2;
        }
        for (const x of [before, after]) {
          if (x != null && x > 0) {
            sum += x;
            w += 1;
          }
        }
        anchor = sum / w;
      }
      const v = anchor * smp.pctOfLastYear;
      if (v > min) {
        min = v;
        source = hot ? "safety min (LY event max)" : "safety min (LY ADR)";
      }
    }
  }
  if (c.lastMinute.enabled && leadDays <= c.lastMinute.withinDays) {
    min = compute(c.lastMinute.mode, c.lastMinute.value);
    source = "last-minute";
  }
  if (c.orphan.enabled && gapInfo(unit, date, m)) {
    min = compute(c.orphan.mode, c.orphan.value);
    source = "orphan";
  }
  return { min: Math.max(0, Math.round(min)), source };
}

/** PriceLabs "Adjacent Factor": adjust the open days right before/after a
 *  booking — a discount fills the gap, a premium discourages back-to-back
 *  turnovers. Skips weekends (per the Weekend Days customization) unless opted
 *  in, and never fires on the booked night itself. Stacks with last-minute and
 *  orphan-day via resolveAdjustmentStack. */
export function adjacentRule(
  unit: Unit,
  date: Date,
  m: MarketProviders,
  cfg: Rules,
): FactorResult | null {
  const c = cfg.adjacent;
  if (!c.enabled || c.value === 0 || (c.daysBefore <= 0 && c.daysAfter <= 0)) return null;
  if (m.isBooked(unit, date)) return null; // the adjustment targets the open neighbors
  if (!c.applyOnWeekends && isWeekendDay(date, cfg)) return null;

  let near: "after" | "before" | null = null;
  for (let k = 1; k <= c.daysAfter && !near; k++) {
    if (m.isBooked(unit, shiftDay(date, -k))) near = "after";
  }
  for (let k = 1; k <= c.daysBefore && !near; k++) {
    if (m.isBooked(unit, shiftDay(date, k))) near = "before";
  }
  if (!near) return null;

  const word = c.value < 0 ? "discount" : "premium";
  if (c.mode === "fixed") {
    return {
      key: "adjacent",
      label: "Adjacent factor",
      factor: 1,
      add: c.value,
      detail: `₪${Math.abs(c.value)} ${word} — ${near} a booking`,
    };
  }
  return {
    key: "adjacent",
    label: "Adjacent factor",
    factor: 1 + c.value,
    detail: `${pct(1 + c.value)} — ${near} a booking`,
  };
}

/** PriceLabs stacking for the gap/lead-time adjustment class (last-minute,
 *  adjacent factor, and orphan-day when it lands): among discounts only the
 *  LARGEST applies; premiums all stack; a mix applies the largest discount plus
 *  every premium. Fixed (₪) entries are compared as a fraction of `reference`
 *  (the unit's base rate). */
export function resolveAdjustmentStack(
  candidates: (FactorResult | null)[],
  reference: number,
): FactorResult[] {
  const applied = candidates.filter((c): c is FactorResult => c !== null);
  if (applied.length <= 1) return applied;
  const depth = (c: FactorResult) => c.factor - 1 + (c.add ? c.add / Math.max(1, reference) : 0);
  const discounts = applied.filter((c) => depth(c) < 0);
  const premiums = applied.filter((c) => depth(c) >= 0);
  if (discounts.length <= 1) return [...discounts, ...premiums];
  let deepest = discounts.reduce((a, b) => (depth(b) < depth(a) ? b : a));
  deepest = { ...deepest, detail: `${deepest.detail} (largest of ${discounts.length} discounts)` };
  return [deepest, ...premiums];
}

/** PriceLabs "Pricing Offset": a final fixed/percent nudge applied AFTER all
 *  other customizations — including the min/max clamp and fixed-price overrides
 *  — so the result may legitimately sit outside the unit's floor/ceiling.
 *  Returns the adjusted rate plus an audit-trail entry. */
export function pricingOffsetRule(
  rate: number,
  cfg: Rules,
): { rate: number; entry: FactorResult } | null {
  const c = cfg.pricingOffset;
  if (!c.enabled || c.value === 0) return null;
  const lim = PRICING_OFFSET_LIMITS[c.mode];
  const v = Math.max(lim.min, Math.min(lim.max, c.value));
  const next = c.mode === "percent" ? rate * (1 + v) : rate + v;
  if (next === rate) return null;
  return {
    rate: next,
    entry: {
      key: "pricingOffset",
      label: "Pricing offset",
      factor: rate > 0 ? next / rate : 1,
      detail: `${c.mode === "percent" ? pct(1 + v) : `₪${v > 0 ? "+" : ""}${v}`} — applied after min/max`,
    },
  };
}

/** LOS pricing adjustment for a stay of `nights`: signed fraction (negative =
 *  discount, positive = premium for short stays) plus the optional per-NIGHT
 *  floor/ceiling for that stay length. A matching LOS tier ("≥ nights", rows
 *  ascending) REPLACES the weekly/monthly/quarterly discount bands; without a
 *  matching tier the bands apply as before. */
export function losAdjustForStay(
  unit: Unit,
  nights: number,
  cfg: Rules = PRICING_RULES,
): { pct: number; minPrice: number | null; maxPrice: number | null } {
  if (!cfg.los.enabled) return { pct: 0, minPrice: null, maxPrice: null };
  let hit: Rules["los"]["tiers"][number] | null = null;
  for (const t of cfg.los.tiers) {
    if (nights >= t.minNights) hit = t; // rows are ascending; the last match wins
  }
  if (hit) return { pct: hit.pct, minPrice: hit.minPrice, maxPrice: hit.maxPrice };
  const weekly = cfg.los.weeklyPct ?? unit.weeklyDiscountPct;
  const monthly = cfg.los.monthlyPct ?? unit.monthlyDiscountPct;
  let disc = 0;
  if (nights >= cfg.los.quarterlyMinNights) disc = Math.max(monthly, cfg.los.quarterlyDiscountPct);
  else if (nights >= 30) disc = monthly;
  else if (nights >= 7) disc = weekly;
  return { pct: -disc, minPrice: null, maxPrice: null };
}

/** Effective per-night rate for a stay of `nights`: the LOS adjustment applied
 *  to the nightly rate, clamped to the tier's per-night min/max where set. */
export function stayNightlyRate(rate: number, unit: Unit, nights: number, cfg: Rules): number {
  const a = losAdjustForStay(unit, nights, cfg);
  let r = rate * (1 + a.pct);
  if (a.minPrice != null && r < a.minPrice) r = a.minPrice;
  if (a.maxPrice != null && r > a.maxPrice) r = a.maxPrice;
  return Math.round(r);
}

/** Back-compat discount view (0..1) — premiums clamp to 0. */
export function losDiscountForStay(unit: Unit, nights: number, cfg: Rules = PRICING_RULES): number {
  return Math.max(0, -losAdjustForStay(unit, nights, cfg).pct);
}
