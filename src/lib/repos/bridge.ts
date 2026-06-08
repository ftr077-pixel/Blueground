import { getSetting, setSetting } from "@/lib/repos/visibility";
import { aggregate, computeBridge, type BridgeOverrides } from "@/lib/bridge/engine";

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
  };
}
