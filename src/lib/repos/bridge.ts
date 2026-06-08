import { getSetting, setSetting } from "@/lib/repos/visibility";
import { getDb } from "@/lib/db";
import { aggregate, computeBridge, type BridgeOverrides } from "@/lib/bridge/engine";

// Real rental-revenue actuals from MiniHotel: the ARI sync writes per-night
// price + booked cells (source = "minihotel") into the Rates Calendar. Booked
// nights × price, summed per month, is realized/on-the-books room revenue.
export function getLiveActuals(): { byMonth: Record<string, number>; months: number } {
  const byMonth: Record<string, number> = {};
  try {
    const rows = getDb()
      .prepare(
        `SELECT substr(date,1,7) AS ym,
                SUM(CASE WHEN booked = 1 AND COALESCE(closed,0) = 0 AND price IS NOT NULL
                         THEN price ELSE 0 END) AS revenue
         FROM rate_calendar WHERE source = 'minihotel' GROUP BY ym`,
      )
      .all() as Array<{ ym: string; revenue: number | null }>;
    for (const r of rows) if (r.revenue && r.revenue > 0) byMonth[r.ym] = Math.round(r.revenue);
  } catch {
    /* rate_calendar may not exist on older DBs — no live actuals then */
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

// Computed model with overrides applied + aggregated to the requested period.
// The chart always uses the monthly series; the table uses the period buckets.
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
  return {
    scenario: result.scenario,
    period,
    periods: agg.periods,
    lines: agg.lines,
    chart: {
      months: result.months,
      revenue: result.series.revenue.map((x) => Math.round(x)),
      ebitda: result.series.ebitda.map((x) => Math.round(x)),
      netIncome: result.series.netIncome.map((x) => Math.round(x)),
    },
    summary: result.summary,
    drivers: result.drivers,
    overrides,
    maxBaselineErrorPct: result.maxBaselineErrorPct,
    actualMonths: result.actualMonths,
    liveActualMonths: live.months,
  };
}
