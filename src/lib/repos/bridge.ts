import { getSetting, setSetting } from "@/lib/repos/visibility";
import { monthlyReservationRevenue } from "@/lib/repos/reservations";
import { aggregate, computeBridge, type BridgeOverrides } from "@/lib/bridge/engine";

// Real rental-revenue actuals from MiniHotel: the actual reservations (room
// revenue) pulled from the Content & Data API, recognized per night across each
// stay and summed per month. No costs exist in MiniHotel, so only revenue lands.
export function getLiveActuals(): { byMonth: Record<string, number>; months: number } {
  let byMonth: Record<string, number> = {};
  try {
    byMonth = monthlyReservationRevenue();
  } catch {
    /* reservation table may not exist on older DBs — no live actuals then */
    byMonth = {};
  }
  return { byMonth, months: Object.keys(byMonth).length };
}

// Driver what-if overrides persist as a JSON blob in the shared meta settings.
const KEY = "bridge_overrides";

export function getOverrides(): BridgeOverrides {
  const raw = getSetting(KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (o && typeof o === "object") {
      const out: BridgeOverrides = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* ignore malformed */
  }
  return {};
}

export function setOverride(key: string, value: number | null): BridgeOverrides {
  const o = getOverrides();
  if (value == null || !Number.isFinite(value)) delete o[key];
  else o[key] = value;
  setSetting(KEY, JSON.stringify(o));
  return o;
}

export function clearOverrides(): void {
  setSetting(KEY, "{}");
}

export type Period = "month" | "quarter" | "year";

// Computed model aggregated to the requested period, carrying BOTH series:
//   plan     — the locked plan of record (no driver overrides), per line
//   monthly  — the forecast (plan + driver what-if overrides applied)
// With no overrides the two are identical. The chart uses the forecast monthlies.
export function getBridgeView(period: Period, base = false) {
  const overrides = base ? {} : getOverrides();
  const result = computeBridge(overrides);

  // Overlay live MiniHotel rental-revenue onto the workbook actuals, per month,
  // for the rental-revenue line (the room revenue the PMS actually measures).
  const live = getLiveActuals();
  if (live.months > 0) {
    for (const ln of result.lines) {
      if (ln.id === "rentalRevenue") {
        ln.actual = result.months.map((m, i) => live.byMonth[m] ?? ln.actual[i]);
      }
    }
  }

  const agg = aggregate(result, period);

  // Locked plan series for the same period buckets (computed without overrides).
  const hasOverrides = Object.keys(overrides).length > 0;
  const planResult = hasOverrides ? computeBridge({}) : result;
  const planAgg = hasOverrides ? aggregate(planResult, period) : agg;
  const planById = new Map(planAgg.lines.map((l) => [l.id, l]));
  const lines = agg.lines.map((ln) => {
    const p = planById.get(ln.id);
    return { ...ln, plan: p?.monthly ?? ln.monthly, planTotal: p?.total ?? ln.total };
  });

  return {
    scenario: result.scenario,
    period,
    periods: agg.periods,
    lines,
    chart: {
      months: result.months,
      revenue: result.series.revenue.map((x) => Math.round(x)),
      ebitda: result.series.ebitda.map((x) => Math.round(x)),
      netIncome: result.series.netIncome.map((x) => Math.round(x)),
    },
    summary: result.summary,
    planSummary: planResult.summary,
    drivers: result.drivers,
    overrides,
    maxBaselineErrorPct: result.maxBaselineErrorPct,
    actualMonths: result.actualMonths,
    liveActualMonths: live.months,
  };
}
