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

export interface Dashboard {
  profiles: DashProfile[];
  listings: DashListing[];
  primaryStay: number;
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

// Monthly (30-night) price — our revenue proxy for a one-month booking.
export function monthlyPrice(l: DashListing): number | null {
  const rows = l.latest.filter((s) => s.nights === 30);
  const found = rows.filter((s) => s.found && s.price != null && s.page != null);
  if (found.length)
    return found.reduce((b, s) => ((s.page as number) < (b.page as number) ? s : b)).price;
  return rows.find((s) => s.price != null)?.price ?? null;
}

export interface Economics {
  revenue: number | null;
  cost: number | null;
  profit: number | null;
  margin: number | null;
  costsKnown: boolean;
}

// Monthly economics: revenue (1-month price) minus rent + utilities + cleaning.
export function economics(l: DashListing): Economics {
  const revenue = monthlyPrice(l);
  const parts = [l.monthlyRent, l.utilities, l.cleaningFee];
  const costsKnown = parts.some((c) => c != null);
  const cost = costsKnown ? parts.reduce<number>((s, c) => s + (c ?? 0), 0) : null;
  const profit = revenue != null && cost != null ? revenue - cost : null;
  const margin = profit != null && revenue ? profit / revenue : null;
  return { revenue, cost, profit, margin, costsKnown };
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
