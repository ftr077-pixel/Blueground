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
export function rawMonthlyPrice(l: DashListing): number | null {
  const rows = l.latest.filter((s) => s.nights === 30);
  const found = rows.filter((s) => s.found && s.price != null && s.page != null);
  if (found.length)
    return found.reduce((b, s) => ((s.page as number) < (b.page as number) ? s : b)).price;
  return rows.find((s) => s.price != null)?.price ?? null;
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
  const e = economics(l, d);
  if (e.revenue == null)
    return { action: "none", urgency: null, reason: "no price scanned yet", suggested: null };
  if (!e.rentKnown)
    return { action: "none", urgency: null, reason: "set rent for a recommendation", suggested: null };

  const page = bestPage(l, primaryStay);
  const marginPct = Math.round((e.margin ?? 0) * 100);
  const rankingWell = page != null && page <= r.rankWellPage;
  const buried = page == null || page >= r.buriedPage;
  const lead = leadDays(primaryCheckIn(l, primaryStay));
  const urgency: Rec["urgency"] =
    lead == null ? "later" : lead <= r.urgentDays ? "now" : lead >= r.relaxedDays ? "later" : "soon";

  let action: RecAction = "hold";
  let reason = `priced about right (${marginPct}% margin${page != null ? `, page ${page}` : ""})`;
  if (rankingWell && marginPct < r.marginLow) {
    action = "raise";
    reason = `page ${page} but only ${marginPct}% margin — room to charge more`;
  } else if (buried && marginPct > r.marginHigh) {
    action = "lower";
    reason = `${page == null ? "not in search" : `page ${page}`} at ${marginPct}% margin — likely overpriced`;
  } else if (buried && marginPct <= r.marginLow) {
    action = "review";
    reason = `buried and thin (${marginPct}%) — can't fix on price alone`;
  }

  let suggested: number | null = null;
  if (action === "raise") {
    suggested = roundTo(e.revenue * (1 + r.stepPct / 100), 50);
  } else if (action === "lower") {
    const feePct = (d.bgFeePct + d.airbnbFeePct) / 100;
    const fixed =
      (l.utilities ?? d.defaultUtilities) +
      (l.cleaningFee ?? d.defaultCleaning) +
      (l.monthlyRent ?? 0);
    const denom = 1 - feePct - r.floorMargin / 100;
    const minRev = denom > 0 ? fixed / denom : Infinity;
    const target = Math.max(e.revenue * (1 - r.stepPct / 100), minRev);
    suggested = target < e.revenue ? roundTo(target, 50) : null;
    if (suggested == null) {
      action = "review";
      reason = "overpriced but already near your floor margin — needs a non-price fix";
    }
  }
  if (action === "lower" && urgency === "later" && lead != null) {
    reason = `${reason}; ${lead}d out, watch for now`;
  }
  return { action, urgency, reason, suggested };
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
