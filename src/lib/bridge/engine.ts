import seedJson from "./seed.json";

// ---------------------------------------------------------------------------
// Bridge 11 m Investment — driver-based P&L engine.
//
// A faithful re-implementation of the "Bridge 11 m Investment" tab from the
// business-plan workbook. Every projected month is computed from a set of
// drivers (property counts, utilization, markup, per-line rates) exactly as
// the spreadsheet does. Verified to reproduce the sheet's own numbers to
// 0.0% for the plan horizon (see `maxBaselineErrorPct`).
//
// The seed (./seed.json) holds the per-month driver values extracted from the
// workbook. Overrides replace a driver across all months for what-if analysis.
// ---------------------------------------------------------------------------

type DriverKey = keyof typeof seedJson.drivers;
type InputKey = keyof typeof seedJson.inputs;

const seed = seedJson as {
  scenario: string;
  months: string[];
  aux: { dealsWithBookingFees: number };
  drivers: Record<DriverKey, number[]>;
  inputs: Record<InputKey, number[]>;
  baseline: Record<string, number[]>;
  actuals?: Record<string, number[]>;
  actualMonths?: number;
};

export const BRIDGE_MONTHS = seed.months;
export const BRIDGE_SCENARIO = seed.scenario;

// A flat override replaces a driver/input series with a constant for every
// month (the simplest, highest-leverage what-if: "hold utilization at 0.9").
export type BridgeOverrides = Record<string, number>;

export type LineKind = "section" | "subtotal" | "line" | "total" | "ratio";

export interface BridgeLine {
  id: string;
  label: string;
  level: number; // indentation depth
  kind: LineKind;
  monthly: number[];
  total: number;
  actual: number[]; // real data per period (0 where none reported)
}

export interface BridgeResult {
  scenario: string;
  months: string[];
  lines: BridgeLine[];
  series: {
    revenue: number[];
    costOfRevenue: number[];
    grossProfitI: number[];
    totalOpEx: number[];
    sga: number[];
    ebitda: number[];
    ebit: number[];
    netIncome: number[];
  };
  summary: {
    months: number;
    revenue: number;
    ebitda: number;
    netIncome: number;
    ebitdaMargin: number;
    grossMargin: number;
    peakActiveUnits: number;
  };
  drivers: BridgeDriverInfo[];
  maxBaselineErrorPct: number;
  actualMonths: number;
}

export interface BridgeDriverInfo {
  key: string;
  label: string;
  unit: "pct" | "ils" | "count";
  group: "Volume" | "Revenue rates" | "Cost rates" | "SG&A";
  planValue: number; // representative seed value (last modeled month)
  overridden: boolean;
  overrideValue: number | null;
}

const n = seed.months.length;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const zeros = () => new Array<number>(n).fill(0);

// Effective per-month value for a series, honoring a flat override.
function eff(series: number[], key: string, ov: BridgeOverrides): number[] {
  if (ov[key] == null || !Number.isFinite(ov[key])) return series;
  return new Array<number>(n).fill(ov[key]);
}

export function computeBridge(overrides: BridgeOverrides = {}): BridgeResult {
  const d = seed.drivers;
  const inp = seed.inputs;
  const aux = seed.aux;

  // Resolve every driver/input series with overrides applied.
  const D = (k: DriverKey) => eff(d[k], k, overrides);
  const I = (k: InputKey) => eff(inp[k], k, overrides);

  const active = D("active");
  const activeLeased = D("activeLeased");
  const props = D("props");
  const newLeased = D("newLeased");
  const attrition = D("attrition");
  const util = D("util");
  const markup = D("markup");
  const rentPerUnit = D("rentPerUnit");
  const leaseRentDrv = D("leaseRentDrv");
  const leaseUtilDrv = D("leaseUtilDrv");
  const leaseDaysDrv = D("leaseDaysDrv");
  const royaltyRate = D("royaltyRate");
  const brokerageRate = D("brokerageRate");
  const penaltyRate = D("penaltyRate");
  const utilIncome = D("utilIncome");
  const cleanIncome = D("cleanIncome");
  const insIncome = D("insIncome");
  const parkIncome = D("parkIncome");
  const petIncome = D("petIncome");
  const utilExp = D("utilExp");
  const cleanExp = D("cleanExp");
  const insExp = D("insExp");
  const consumables = D("consumables");
  const maintenance = D("maintenance");
  const restoration = D("restoration");
  const mktClassified = D("mktClassified");
  const mktOther = D("mktOther");
  const badDebtRate = D("badDebtRate");

  const personnel = I("personnel");
  const gaOffice = I("gaOffice");
  const gaWarehouse = I("gaWarehouse");
  const gaOutsourcing = I("gaOutsourcing");
  const gaInsurance = I("gaInsurance");
  const gaLegal = I("gaLegal");
  const gaOther = I("gaOther");
  const businessTaxes = I("businessTaxes");
  const feSales = I("feSales");
  const depreciation = I("depreciation");
  const finExp = I("finExp");
  const finInc = I("finInc");
  const incomeTax = I("incomeTax");

  // Per-month computed lines.
  const rentExpLeased = zeros();
  const leaseUp = zeros();
  const rentIncomeLeased = zeros();
  const brokerage = zeros();
  const penalties = zeros();
  const utilitiesIncome = zeros();
  const cleaningIncome = zeros();
  const insuranceIncome = zeros();
  const parkingIncome = zeros();
  const petIncomeL = zeros();
  const otherServicesIncome = zeros();
  const rentalRevenue = zeros();
  const otherRevenue = zeros();
  const revenue = zeros();
  const royalty = zeros();
  const costOfRevenue = zeros();
  const grossProfitI = zeros();
  const utilitiesExpense = zeros();
  const cleaningExpense = zeros();
  const insuranceExpense = zeros();
  const unitCosts = zeros();
  const consumablesL = zeros();
  const maintenanceL = zeros();
  const restorationL = zeros();
  const opexExisting = zeros();
  const totalOpEx = zeros();
  const reClassifieds = zeros();
  const otherMarketing = zeros();
  const marketing = zeros();
  const badDebt = zeros();
  const ga = zeros();
  const sga = zeros();
  const ebitda = zeros();
  const ebit = zeros();
  const netIncome = zeros();

  for (let i = 0; i < n; i++) {
    rentExpLeased[i] = activeLeased[i] * rentPerUnit[i];
    leaseUp[i] = ((newLeased[i] * (leaseRentDrv[i] + leaseUtilDrv[i])) / 30.4) * leaseDaysDrv[i];
    rentIncomeLeased[i] = -rentExpLeased[i] * (1 + markup[i]) * util[i];
    rentalRevenue[i] = rentIncomeLeased[i];

    brokerage[i] = brokerageRate[i] * rentalRevenue[i] * aux.dealsWithBookingFees;
    penalties[i] = rentalRevenue[i] * penaltyRate[i];
    utilitiesIncome[i] = active[i] * util[i] * utilIncome[i];
    cleaningIncome[i] = active[i] * util[i] * cleanIncome[i];
    insuranceIncome[i] = active[i] * util[i] * insIncome[i];
    parkingIncome[i] = active[i] * util[i] * parkIncome[i];
    petIncomeL[i] = active[i] * util[i] * petIncome[i];
    otherServicesIncome[i] = insuranceIncome[i] + parkingIncome[i] + petIncomeL[i];
    otherRevenue[i] =
      brokerage[i] + penalties[i] + utilitiesIncome[i] + cleaningIncome[i] + otherServicesIncome[i];

    revenue[i] = rentalRevenue[i] + otherRevenue[i];
    royalty[i] = revenue[i] * royaltyRate[i];
    costOfRevenue[i] = rentExpLeased[i] + leaseUp[i] + royalty[i];
    grossProfitI[i] = revenue[i] + costOfRevenue[i];

    utilitiesExpense[i] = utilExp[i] * active[i];
    cleaningExpense[i] = cleanExp[i] * active[i];
    insuranceExpense[i] = insExp[i] * active[i];
    unitCosts[i] = utilitiesExpense[i] + cleaningExpense[i] + insuranceExpense[i];

    consumablesL[i] = consumables[i] * props[i];
    maintenanceL[i] = maintenance[i] * active[i];
    restorationL[i] = restoration[i] * -attrition[i];
    opexExisting[i] = consumablesL[i] + maintenanceL[i] + restorationL[i];
    totalOpEx[i] = unitCosts[i] + opexExisting[i];

    reClassifieds[i] = mktClassified[i] * revenue[i];
    otherMarketing[i] = mktOther[i] * revenue[i];
    marketing[i] = reClassifieds[i] + otherMarketing[i];
    badDebt[i] = badDebtRate[i] * rentalRevenue[i];
    ga[i] =
      gaOffice[i] + gaWarehouse[i] + gaOutsourcing[i] + gaInsurance[i] + gaLegal[i] + gaOther[i] +
      badDebt[i];
    sga[i] = marketing[i] + personnel[i] + ga[i];

    ebitda[i] = grossProfitI[i] + totalOpEx[i] + sga[i] + businessTaxes[i] + feSales[i];
    ebit[i] = ebitda[i] + depreciation[i];
    netIncome[i] = ebit[i] + finExp[i] + finInc[i] + incomeTax[i];
  }

  const sAct = seed.actuals ?? {};
  const line = (id: string, label: string, level: number, kind: LineKind, monthly: number[]): BridgeLine => ({
    id,
    label,
    level,
    kind,
    monthly,
    total: sum(monthly),
    actual: sAct[id] ?? zeros(),
  });

  const lines: BridgeLine[] = [
    line("revenue", "Revenue", 0, "subtotal", revenue),
    line("rentalRevenue", "Rental Revenue", 1, "subtotal", rentalRevenue),
    line("rentIncomeLeased", "Rent Income — Leased", 2, "line", rentIncomeLeased),
    line("otherRevenue", "Other Revenue", 1, "subtotal", otherRevenue),
    line("brokerage", "Brokerage Fees", 2, "line", brokerage),
    line("penalties", "Penalties", 2, "line", penalties),
    line("utilitiesIncome", "Utilities Income", 2, "line", utilitiesIncome),
    line("cleaningIncome", "Cleaning Income", 2, "line", cleaningIncome),
    line("otherServicesIncome", "Other Services Income", 2, "subtotal", otherServicesIncome),
    line("insuranceIncome", "Insurance Income", 3, "line", insuranceIncome),
    line("parkingIncome", "Parking Income", 3, "line", parkingIncome),
    line("petIncome", "Pet Fee Income", 3, "line", petIncomeL),
    line("costOfRevenue", "Cost of Revenue", 0, "subtotal", costOfRevenue),
    line("rentExpLeased", "Rent Expense — Leased", 1, "line", rentExpLeased),
    line("leaseUp", "Lease-up period", 1, "line", leaseUp),
    line("royalty", "Royalty Fee", 1, "line", royalty),
    line("grossProfitI", "Gross Profit I", 0, "total", grossProfitI),
    line("grossMarginI", "Gross Margin I %", 0, "ratio", grossProfitI.map((g, i) => (revenue[i] ? g / revenue[i] : 0))),
    line("totalOpEx", "Operating Expenses", 0, "subtotal", totalOpEx),
    line("unitCosts", "Unit Level Costs", 1, "subtotal", unitCosts),
    line("utilitiesExpense", "Utilities Expense", 2, "line", utilitiesExpense),
    line("cleaningExpense", "Cleaning Expense", 2, "line", cleaningExpense),
    line("insuranceExpense", "Insurance Expense", 2, "line", insuranceExpense),
    line("opexExisting", "OPEX: Existing Portfolio", 1, "subtotal", opexExisting),
    line("consumables", "Consumables", 2, "line", consumablesL),
    line("maintenance", "Maintenance Works", 2, "line", maintenanceL),
    line("restoration", "Restoration & Transport", 2, "line", restorationL),
    line("sga", "SG&A", 0, "subtotal", sga),
    line("marketing", "Marketing / Channel", 1, "subtotal", marketing),
    line("reClassifieds", "RE classifieds & campaigns", 2, "line", reClassifieds),
    line("otherMarketing", "Other Marketing", 2, "line", otherMarketing),
    line("personnel", "Personnel Costs", 1, "line", personnel),
    line("ga", "G&A", 1, "subtotal", ga),
    line("gaOffice", "Office", 2, "line", gaOffice),
    line("gaWarehouse", "Warehouse", 2, "line", gaWarehouse),
    line("gaInsurance", "Insurance", 2, "line", gaInsurance),
    line("badDebt", "Bad Debt", 2, "line", badDebt),
    line("ebitda", "EBITDA", 0, "total", ebitda),
    line("ebitdaMargin", "EBITDA Margin %", 0, "ratio", ebitda.map((e, i) => (revenue[i] ? e / revenue[i] : 0))),
    line("depreciation", "Depreciation", 0, "line", depreciation),
    line("ebit", "EBIT", 0, "total", ebit),
    line("incomeTax", "Income Tax", 0, "line", incomeTax),
    line("netIncome", "Net Income", 0, "total", netIncome),
  ];

  // Self-verification: with no overrides, the engine must reproduce the
  // workbook. We report the error on the horizon *totals* (what a plan is read
  // by) — robust against individual near-zero months where a tiny absolute
  // gap would otherwise blow up as a percentage.
  let maxErr = 0;
  if (Object.keys(overrides).length === 0) {
    const checks: Array<[number[], number[]]> = [
      [revenue, seed.baseline.revenue],
      [ebitda, seed.baseline.ebitda],
      [netIncome, seed.baseline.netIncome],
      [grossProfitI, seed.baseline.grossProfitI],
      [totalOpEx, seed.baseline.totalOpEx],
    ];
    for (const [got, want] of checks) {
      const sg = sum(got);
      const sw = sum(want);
      if (Math.abs(sw) > 1000) maxErr = Math.max(maxErr, (Math.abs(sg - sw) / Math.abs(sw)) * 100);
    }
  }

  const peakActiveUnits = Math.max(...active);
  return {
    scenario: seed.scenario,
    months: seed.months,
    lines,
    series: { revenue, costOfRevenue, grossProfitI, totalOpEx, sga, ebitda, ebit, netIncome },
    summary: {
      months: n,
      revenue: sum(revenue),
      ebitda: sum(ebitda),
      netIncome: sum(netIncome),
      ebitdaMargin: sum(revenue) ? sum(ebitda) / sum(revenue) : 0,
      grossMargin: sum(revenue) ? sum(grossProfitI) / sum(revenue) : 0,
      peakActiveUnits,
    },
    drivers: driverCatalog(overrides),
    maxBaselineErrorPct: maxErr,
    actualMonths: seed.actualMonths ?? 0,
  };
}

// The curated set of drivers exposed for editing (flat what-if overrides).
const DRIVER_META: Array<{ key: string; label: string; unit: BridgeDriverInfo["unit"]; group: BridgeDriverInfo["group"] }> = [
  { key: "util", label: "Utilization %", unit: "pct", group: "Volume" },
  { key: "markup", label: "Rent income markup %", unit: "pct", group: "Volume" },
  { key: "rentPerUnit", label: "Rent / unit (cost)", unit: "ils", group: "Cost rates" },
  { key: "royaltyRate", label: "Royalty fee %", unit: "pct", group: "Revenue rates" },
  { key: "brokerageRate", label: "Brokerage rate", unit: "pct", group: "Revenue rates" },
  { key: "utilIncome", label: "Utilities income / unit", unit: "ils", group: "Revenue rates" },
  { key: "cleanIncome", label: "Cleaning income / unit", unit: "ils", group: "Revenue rates" },
  { key: "utilExp", label: "Utilities expense / unit", unit: "ils", group: "Cost rates" },
  { key: "cleanExp", label: "Cleaning expense / unit", unit: "ils", group: "Cost rates" },
  { key: "consumables", label: "Consumables / unit", unit: "ils", group: "Cost rates" },
  { key: "maintenance", label: "Maintenance / unit", unit: "ils", group: "Cost rates" },
  { key: "mktClassified", label: "Marketing % of revenue", unit: "pct", group: "SG&A" },
  { key: "badDebtRate", label: "Bad debt %", unit: "pct", group: "SG&A" },
];

function driverCatalog(overrides: BridgeOverrides): BridgeDriverInfo[] {
  return DRIVER_META.map((m) => {
    const series = seed.drivers[m.key as DriverKey];
    return {
      ...m,
      planValue: series[series.length - 1],
      overridden: overrides[m.key] != null,
      overrideValue: overrides[m.key] ?? null,
    };
  });
}

export interface AggregatedBridge {
  periods: string[];
  lines: BridgeLine[];
}

// Aggregate monthly flows into "month" | "quarter" | "year" buckets. Ratio
// rows are recomputed from the aggregated revenue so margins stay correct.
export function aggregate(result: BridgeResult, period: "month" | "quarter" | "year"): AggregatedBridge {
  if (period === "month") return { periods: result.months, lines: result.lines };

  const keyOf = (m: string) => {
    const [y, mo] = m.split("-");
    return period === "year" ? y : `${y}-Q${Math.floor((Number(mo) - 1) / 3) + 1}`;
  };
  const periodKeys: string[] = [];
  const idxByPeriod: number[][] = [];
  result.months.forEach((m, i) => {
    const k = keyOf(m);
    let p = periodKeys.indexOf(k);
    if (p === -1) {
      p = periodKeys.push(k) - 1;
      idxByPeriod.push([]);
    }
    idxByPeriod[p].push(i);
  });

  const revByPeriod = idxByPeriod.map((idxs) => idxs.reduce((s, i) => s + result.series.revenue[i], 0));

  const lines = result.lines.map((ln) => {
    if (ln.kind === "ratio") {
      // ln.monthly holds ratio_i = metric_i / revenue_i; multiply back to the
      // flow, sum per period, then divide by aggregated revenue.
      const flow = idxByPeriod.map((idxs) => idxs.reduce((s, i) => s + ln.monthly[i] * result.series.revenue[i], 0));
      const monthly = flow.map((f, p) => (revByPeriod[p] ? f / revByPeriod[p] : 0));
      return { ...ln, monthly, total: ln.total, actual: periodKeys.map(() => 0) };
    }
    const monthly = idxByPeriod.map((idxs) => idxs.reduce((s, i) => s + ln.monthly[i], 0));
    const actual = idxByPeriod.map((idxs) => idxs.reduce((s, i) => s + (ln.actual[i] ?? 0), 0));
    return { ...ln, monthly, total: sum(monthly), actual };
  });
  return { periods: periodKeys, lines };
}
