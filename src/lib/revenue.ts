// Shared, client-safe helpers for the Revenue & Yield views. Pure functions over
// the /api/visibility (dashboard) payload — no React, no server imports.

export interface DashSnapshot {
  id: string;
  ts: string;
  stayLabel: string;
  nights: number;
  checkIn: string;
  eligible: boolean;
  available: boolean | null;
  found: boolean;
  page: number | null;
  position: number | null;
  rank: number | null;
  total: number | null;
  price: number | null;
}

export interface DashListing {
  id: string;
  airbnbId: string;
  label: string;
  profileId: string;
  guests: number | null;
  monthlyRent: number | null;
  utilities: number | null;
  cleaningFee: number | null;
  address: string | null;
  active: boolean;
  latest: DashSnapshot[];
}

export interface DashProfile {
  id: string;
  label: string;
  currency: string;
  stayNights: number[];
  lastRunAt: string | null;
  active: boolean;
}

export interface CostDefaults {
  bgFeePct: number;
  airbnbFeePct: number;
  defaultUtilities: number;
  defaultCleaning: number;
  weeklyDiscountPct: number;
  biWeeklyDiscountPct: number;
  monthlyDiscountPct: number;
}

export interface Dashboard {
  profiles: DashProfile[];
  listings: DashListing[];
  primaryStay: number;
  costDefaults: CostDefaults;
}

export const STAY_LABELS: Record<number, string> = {
  7: "1 week",
  14: "2 weeks",
  30: "1 month",
  60: "2 months",
  90: "3 months",
};
export const nightsLabel = (n: number) => STAY_LABELS[n] ?? `${n} nights`;

export function fmtMoney(n: number | null, currency = "₪") {
  return n != null ? `${currency}${Math.round(n).toLocaleString()}` : "—";
}
export function fmtPct(n: number | null) {
  return n != null ? `${Math.round(n * 100)}%` : "—";
}

// Best (lowest-page) found snapshot for a given stay length.
export function bestForStay(l: DashListing, nights: number): DashSnapshot | null {
  const found = l.latest.filter((s) => s.nights === nights && s.found && s.page != null);
  if (!found.length) return null;
  return found.reduce((b, s) => ((s.page as number) < (b.page as number) ? s : b));
}
export function bestPage(l: DashListing, nights: number): number | null {
  return bestForStay(l, nights)?.page ?? null;
}

// True if the listing showed any availability for a stay length in the last scan.
export function availableForStay(l: DashListing, nights: number): boolean {
  return l.latest.some((s) => s.nights === nights && (s.available === true || s.found));
}

// The scraped list price (gross, before length-of-stay discount) for 30 nights.
// A snapshot's price as a whole-stay total. Search results already give the stay
// total; a not-found listing only carries its nightly calendar rate, so scale it
// by the number of nights to get a comparable monthly figure.
export function snapStayPrice(s: {
  found: boolean;
  nights: number;
  price: number | null;
}): number | null {
  if (s.price == null) return null;
  return s.found ? s.price : s.price * s.nights;
}

export function rawMonthlyPrice(l: DashListing): number | null {
  const rows = l.latest.filter((s) => s.nights === 30);
  const found = rows.filter((s) => s.found && s.price != null && s.page != null);
  if (found.length)
    return found.reduce((b, s) => ((s.page as number) < (b.page as number) ? s : b)).price;
  const priced = rows.find((s) => s.price != null);
  return priced ? snapStayPrice(priced) : null;
}

export type LosDiscounts = {
  weeklyDiscountPct: number;
  biWeeklyDiscountPct: number;
  monthlyDiscountPct: number;
};

// Fixed length-of-stay discount for a stay of `nights`: monthly for 28+,
// two-week for 14-27, weekly for 7-13, none below a week.
export function losDiscountPct(nights: number, d: LosDiscounts): number {
  if (nights >= 28) return d.monthlyDiscountPct;
  if (nights >= 14) return d.biWeeklyDiscountPct;
  if (nights >= 7) return d.weeklyDiscountPct;
  return 0;
}
export function applyLos(raw: number | null, nights: number, d: LosDiscounts): number | null {
  if (raw == null) return null;
  return raw * (1 - losDiscountPct(nights, d) / 100);
}

// Monthly revenue = the 1-month list price with your fixed monthly discount applied.
export function monthlyPrice(l: DashListing, d: CostDefaults): number | null {
  return applyLos(rawMonthlyPrice(l), 30, d);
}

export interface Economics {
  revenue: number | null;
  bgFee: number | null;
  airbnbFee: number | null;
  utilities: number;
  cleaning: number;
  rent: number | null;
  rentKnown: boolean;
  cost: number | null;
  profit: number | null;
  margin: number | null;
}

// Monthly economics. Revenue = 1-month price. Costs = BG franchise fee (% of
// gross revenue) + utilities + cleaning + rent. Utilities and cleaning fall back
// to the configured defaults; rent has no default (set per property).
export function economics(l: DashListing, d: CostDefaults): Economics {
  const revenue = monthlyPrice(l, d);
  const bgFee = revenue != null ? (revenue * d.bgFeePct) / 100 : null;
  const airbnbFee = revenue != null ? (revenue * d.airbnbFeePct) / 100 : null;
  const utilities = l.utilities ?? d.defaultUtilities;
  const cleaning = l.cleaningFee ?? d.defaultCleaning;
  const rent = l.monthlyRent;
  const rentKnown = rent != null;
  const cost =
    revenue != null ? (bgFee ?? 0) + (airbnbFee ?? 0) + utilities + cleaning + (rent ?? 0) : null;
  const profit = revenue != null && cost != null ? revenue - cost : null;
  const margin = profit != null && revenue ? profit / revenue : null;
  return { revenue, bgFee, airbnbFee, utilities, cleaning, rent, rentKnown, cost, profit, margin };
}

export interface PricingRules {
  marginLow: number; // below this %, a well-ranked listing is "too cheap"
  marginHigh: number; // above this %, a buried listing is "too expensive"
  rankWellPage: number; // page <= this counts as ranking well
  buriedPage: number; // page >= this (or not found) counts as buried
  urgentDays: number; // available within this many days = act now
  relaxedDays: number; // available beyond this = no rush
  stepPct: number; // suggested price change size
  floorMargin: number; // never suggest lowering below this %
}

export type RecAction = "raise" | "lower" | "hold" | "review" | "none";

export interface Rec {
  action: RecAction;
  urgency: "now" | "soon" | "later" | null;
  reason: string;
  suggested: number | null;
}

// Earliest scanned check-in for a stay length — the soonest booking window.
export function primaryCheckIn(l: DashListing, nights: number): string | null {
  const rows = l.latest.filter((s) => s.nights === nights && s.checkIn);
  if (!rows.length) return null;
  return rows.reduce((b, s) => (s.checkIn < b.checkIn ? s : b)).checkIn;
}
export function leadDays(checkIn: string | null): number | null {
  if (!checkIn) return null;
  const dt = new Date(`${checkIn}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dt.getTime() - today.getTime()) / 86_400_000);
}

const roundTo = (n: number, step: number) => Math.round(n / step) * step;

// Price recommendation from position x margin, with lead-time urgency.
export function recommend(
  l: DashListing,
  d: CostDefaults,
  r: PricingRules,
  primaryStay: number,
): Rec {
  if (l.monthlyRent == null)
    return { action: "none", urgency: null, reason: "set rent for a recommendation", suggested: null };
  if (!availableForStay(l, primaryStay))
    return { action: "none", urgency: null, reason: "not available — nothing to price", suggested: null };

  const e = economics(l, d);
  const page = bestPage(l, primaryStay);
  const marginPct = e.margin != null ? Math.round(e.margin * 100) : null;
  const buried = page == null || page >= r.buriedPage;
  const rankingWell = page != null && page <= r.rankWellPage;

  const lead = leadDays(primaryCheckIn(l, primaryStay));
  const urgency: Rec["urgency"] =
    lead == null ? "later" : lead <= r.urgentDays ? "now" : lead >= r.relaxedDays ? "later" : "soon";
  const wait = urgency === "later" && lead != null ? `; ${lead}d out, watch for now` : "";

  // Available but invisible (not found, or ranked deep) — price is the lever.
  if (buried) {
    const pos = page == null ? "not in search" : `page ${page}`;
    let suggested: number | null = null;
    if (e.revenue != null) {
      const feePct = (d.bgFeePct + d.airbnbFeePct) / 100;
      const fixed =
        (l.utilities ?? d.defaultUtilities) +
        (l.cleaningFee ?? d.defaultCleaning) +
        (l.monthlyRent ?? 0);
      const denom = 1 - feePct - r.floorMargin / 100;
      const minRev = denom > 0 ? fixed / denom : Infinity;
      const stepRev = e.revenue * (1 - r.stepPct / 100);
      if (stepRev > minRev) suggested = roundTo(Math.max(stepRev, minRev), 50);
    }
    if (suggested != null) {
      const room = marginPct != null && marginPct > r.marginHigh ? "lots of room" : "room";
      return {
        action: "lower",
        urgency,
        suggested,
        reason: `${pos} but available${marginPct != null ? ` at ${marginPct}% margin` : ""} — ${room} to drop the price and compete${wait}`,
      };
    }
    return {
      action: "review",
      urgency,
      suggested: null,
      reason:
        e.revenue == null
          ? `${pos} but available — no price captured, review manually`
          : `${pos} but available — margin too thin to cut on price; needs a non-price fix`,
    };
  }

  // Ranking well but underpriced — raise.
  if (rankingWell && marginPct != null && marginPct < r.marginLow) {
    return {
      action: "raise",
      urgency,
      suggested: e.revenue != null ? roundTo(e.revenue * (1 + r.stepPct / 100), 50) : null,
      reason: `page ${page} but only ${marginPct}% margin — room to charge more`,
    };
  }

  return {
    action: "hold",
    urgency,
    suggested: null,
    reason: `priced about right${marginPct != null ? ` (${marginPct}% margin)` : ""}${
      page != null ? `, page ${page}` : ""
    }`,
  };
}

export const CHART = {
  grid: "hsl(214 32% 91%)",
  axis: "hsl(215 16% 47%)",
  blue: "#2563eb",
  green: "#16a34a",
  slate: "#64748b",
  red: "#dc2626",
  amber: "#d97706",
};
