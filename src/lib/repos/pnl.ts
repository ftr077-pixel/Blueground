import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getSetting, setSetting, listListings } from "@/lib/repos/visibility";
import { listUnits } from "@/lib/repos/units";

// A month has ~30.4 days on average; used to turn a nightly rate into a
// monthly revenue figure.
const DAYS_PER_MONTH = 30.4;
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ------------------------------------------------------------------ manual lines
// A manual P&L line is anything the operator types in that isn't already
// derivable from the portfolio — e.g. accounting, software, arnona, insurance,
// or an extra revenue stream. This is the hook for "operational costs and
// stuff" that grows over time.
export interface PnlLine {
  id: string;
  label: string;
  category: "revenue" | "cost";
  section: string;
  monthlyAmount: number;
  growthPct: number; // % applied per month across the horizon
  active: boolean;
  sort: number;
  createdAt: string;
}

interface PnlLineSql {
  id: string;
  label: string;
  category: "revenue" | "cost";
  section: string;
  monthly_amount: number;
  growth_pct: number;
  active: number;
  sort: number;
  created_at: string;
}

function rowToLine(r: PnlLineSql): PnlLine {
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    section: r.section,
    monthlyAmount: r.monthly_amount,
    growthPct: r.growth_pct,
    active: !!r.active,
    sort: r.sort,
    createdAt: r.created_at,
  };
}

export function listPnlLines(): PnlLine[] {
  const db = getDb();
  return (
    db.prepare("SELECT * FROM pnl_lines ORDER BY category DESC, sort, created_at").all() as PnlLineSql[]
  ).map(rowToLine);
}

export interface PnlLineInput {
  label: string;
  category: "revenue" | "cost";
  section?: string;
  monthlyAmount?: number;
  growthPct?: number;
}

export function createPnlLine(input: PnlLineInput): PnlLine {
  const db = getDb();
  const id = "pnl-" + randomUUID().slice(0, 8);
  const max = db.prepare("SELECT MAX(sort) AS m FROM pnl_lines").get() as { m: number | null };
  db.prepare(
    `INSERT INTO pnl_lines (id, label, category, section, monthly_amount, growth_pct, active, sort, created_at)
     VALUES (@id, @label, @category, @section, @monthly_amount, @growth_pct, 1, @sort, @created_at)`,
  ).run({
    id,
    label: input.label.trim() || "Untitled line",
    category: input.category === "revenue" ? "revenue" : "cost",
    section: (input.section ?? "Operating").trim() || "Operating",
    monthly_amount: Number.isFinite(input.monthlyAmount) ? input.monthlyAmount : 0,
    growth_pct: Number.isFinite(input.growthPct) ? input.growthPct : 0,
    sort: (max.m ?? 0) + 1,
    created_at: new Date().toISOString(),
  });
  return rowToLine(db.prepare("SELECT * FROM pnl_lines WHERE id = ?").get(id) as PnlLineSql);
}

export function updatePnlLine(
  id: string,
  patch: Partial<PnlLineInput> & { active?: boolean },
): void {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM pnl_lines WHERE id = ?").get(id) as PnlLineSql | undefined;
  if (!cur) return;
  db.prepare(
    `UPDATE pnl_lines SET label=@label, category=@category, section=@section,
       monthly_amount=@monthly_amount, growth_pct=@growth_pct, active=@active WHERE id=@id`,
  ).run({
    id,
    label: (patch.label ?? cur.label).trim() || cur.label,
    category: patch.category ?? cur.category,
    section: (patch.section ?? cur.section).trim() || cur.section,
    monthly_amount: patch.monthlyAmount !== undefined ? patch.monthlyAmount : cur.monthly_amount,
    growth_pct: patch.growthPct !== undefined ? patch.growthPct : cur.growth_pct,
    active: (patch.active ?? !!cur.active) ? 1 : 0,
  });
}

export function deletePnlLine(id: string): void {
  getDb().prepare("DELETE FROM pnl_lines WHERE id = ?").run(id);
}

// ------------------------------------------------------------------ assumptions
// Portfolio-wide knobs stored in the shared `meta` settings namespace.
export interface PnlAssumptions {
  horizonMonths: number;
  revenueGrowthPct: number; // monthly % applied to derived rental income
  costGrowthPct: number; // monthly % applied to derived direct costs
  mgmtFeePct: number; // % of gross revenue booked as a management cost
}

const DEFAULTS: PnlAssumptions = {
  horizonMonths: 12,
  revenueGrowthPct: 0,
  costGrowthPct: 0,
  mgmtFeePct: 0,
};

function num(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw == null) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getAssumptions(): PnlAssumptions {
  const horizon = Math.max(1, Math.min(36, Math.round(num("pnl_horizon_months", DEFAULTS.horizonMonths))));
  return {
    horizonMonths: horizon,
    revenueGrowthPct: num("pnl_revenue_growth_pct", DEFAULTS.revenueGrowthPct),
    costGrowthPct: num("pnl_cost_growth_pct", DEFAULTS.costGrowthPct),
    mgmtFeePct: num("pnl_mgmt_fee_pct", DEFAULTS.mgmtFeePct),
  };
}

export function setAssumptions(patch: Partial<PnlAssumptions>): PnlAssumptions {
  if (patch.horizonMonths !== undefined)
    setSetting("pnl_horizon_months", String(Math.max(1, Math.min(36, Math.round(patch.horizonMonths)))));
  if (patch.revenueGrowthPct !== undefined)
    setSetting("pnl_revenue_growth_pct", String(patch.revenueGrowthPct));
  if (patch.costGrowthPct !== undefined)
    setSetting("pnl_cost_growth_pct", String(patch.costGrowthPct));
  if (patch.mgmtFeePct !== undefined) setSetting("pnl_mgmt_fee_pct", String(patch.mgmtFeePct));
  return getAssumptions();
}

// ------------------------------------------------------------------ forecast
export interface PnlMonth {
  key: string; // YYYY-MM
  label: string; // "Jun '26"
}

export interface PnlRow {
  id: string;
  label: string;
  section: string;
  category: "revenue" | "cost";
  kind: "derived" | "manual";
  editable: boolean;
  monthly: number[];
  total: number;
  note?: string;
  // present on manual rows so the UI can edit them from a single fetch
  lineId?: string;
  base?: number;
  growthPct?: number;
}

export interface PnlForecast {
  months: PnlMonth[];
  rows: PnlRow[];
  revenueByMonth: number[];
  costByMonth: number[];
  netByMonth: number[];
  marginByMonth: number[];
  summary: {
    monthlyRevenue: number;
    monthlyCost: number;
    monthlyNet: number;
    margin: number;
    annualRevenue: number;
    annualCost: number;
    annualNet: number;
    units: number;
    horizonMonths: number;
  };
  assumptions: PnlAssumptions;
  basis: {
    units: number;
    monthlyDerivedRevenue: number;
    monthlyDerivedDirectCost: number;
    costLinesEntered: boolean;
  };
}

function buildMonths(n: number): PnlMonth[] {
  const now = new Date();
  const out: PnlMonth[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: `${MONTH_LABELS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`,
    });
  }
  return out;
}

// A base value compounded by a per-month growth rate across the horizon.
function series(base: number, monthlyGrowthPct: number, n: number): number[] {
  const g = 1 + monthlyGrowthPct / 100;
  return Array.from({ length: n }, (_, i) => base * Math.pow(g, i));
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function computeForecast(): PnlForecast {
  const a = getAssumptions();
  const n = a.horizonMonths;
  const months = buildMonths(n);
  const zeros = () => Array.from({ length: n }, () => 0);

  const units = listUnits();
  const lines = listPnlLines().filter((l) => l.active);
  // Only apartments that are live contribute operating costs.
  const listings = listListings().filter((l) => l.active);

  // ---- derived revenue: nightly rate × days × occupancy, summed over units.
  // current_rate is written by the Pricing Specialist, so this tracks pricing.
  const monthlyDerivedRevenue = sum(
    units.map((u) => u.currentRate * DAYS_PER_MONTH * u.occupancy30d),
  );

  // ---- derived direct costs: from the rent/utilities/cleaning you set per
  // apartment in the Manage panel.
  const rent = sum(listings.map((l) => l.monthlyRent ?? 0));
  const utilities = sum(listings.map((l) => l.utilities ?? 0));
  const cleaning = sum(listings.map((l) => l.cleaningFee ?? 0));
  const costLinesEntered = rent + utilities + cleaning > 0 || lines.some((l) => l.category === "cost");

  const rows: PnlRow[] = [];
  const push = (
    id: string,
    label: string,
    section: string,
    category: "revenue" | "cost",
    kind: "derived" | "manual",
    monthly: number[],
    extra: Partial<PnlRow> = {},
  ) => {
    rows.push({
      id,
      label,
      section,
      category,
      kind,
      editable: kind === "manual",
      monthly,
      total: sum(monthly),
      ...extra,
    });
  };

  // -- revenue rows
  push(
    "rev-rental",
    "Rental income (rate × occupancy)",
    "Revenue",
    "revenue",
    "derived",
    series(monthlyDerivedRevenue, a.revenueGrowthPct, n),
    { note: `${units.length} units · derived from live rates` },
  );
  for (const l of lines.filter((l) => l.category === "revenue")) {
    push("man-" + l.id, l.label, l.section, "revenue", "manual", series(l.monthlyAmount, l.growthPct, n), {
      lineId: l.id,
      base: l.monthlyAmount,
      growthPct: l.growthPct,
    });
  }

  const revenueByMonth = months.map((_, i) =>
    sum(rows.filter((r) => r.category === "revenue").map((r) => r.monthly[i])),
  );

  // -- cost rows (derived first, then the management fee that scales with
  // revenue, then manual operating lines)
  if (rent > 0) push("cost-rent", "Apartment rent", "Direct", "cost", "derived", series(rent, a.costGrowthPct, n));
  if (utilities > 0)
    push("cost-utils", "Utilities (water / electric)", "Direct", "cost", "derived", series(utilities, a.costGrowthPct, n));
  if (cleaning > 0)
    push("cost-clean", "Cleaning / turnovers", "Direct", "cost", "derived", series(cleaning, a.costGrowthPct, n), {
      note: "≈1 turnover per month",
    });
  if (a.mgmtFeePct > 0)
    push(
      "cost-mgmt",
      `Management fee (${a.mgmtFeePct}% of revenue)`,
      "Direct",
      "cost",
      "derived",
      revenueByMonth.map((r) => (r * a.mgmtFeePct) / 100),
    );
  for (const l of lines.filter((l) => l.category === "cost")) {
    push("man-" + l.id, l.label, l.section, "cost", "manual", series(l.monthlyAmount, l.growthPct, n), {
      lineId: l.id,
      base: l.monthlyAmount,
      growthPct: l.growthPct,
    });
  }

  const costByMonth = months.map((_, i) =>
    sum(rows.filter((r) => r.category === "cost").map((r) => r.monthly[i])),
  );
  const netByMonth = months.map((_, i) => revenueByMonth[i] - costByMonth[i]);
  const marginByMonth = months.map((_, i) =>
    revenueByMonth[i] > 0 ? netByMonth[i] / revenueByMonth[i] : 0,
  );

  const annualRevenue = sum(revenueByMonth);
  const annualCost = sum(costByMonth);
  const annualNet = sum(netByMonth);

  return {
    months,
    rows,
    revenueByMonth,
    costByMonth,
    netByMonth,
    marginByMonth,
    summary: {
      monthlyRevenue: revenueByMonth[0] ?? 0,
      monthlyCost: costByMonth[0] ?? 0,
      monthlyNet: netByMonth[0] ?? 0,
      margin: marginByMonth[0] ?? 0,
      annualRevenue,
      annualCost,
      annualNet,
      units: units.length,
      horizonMonths: n,
    },
    assumptions: a,
    basis: {
      units: units.length,
      monthlyDerivedRevenue,
      monthlyDerivedDirectCost: rent + utilities + cleaning,
      costLinesEntered,
    },
  };
}
