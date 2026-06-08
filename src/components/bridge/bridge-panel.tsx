"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, BadgeCheck, Building2, Loader2, Percent, RotateCcw, TrendingUp } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatTile } from "@/components/stat-tile";

type Kind = "section" | "subtotal" | "line" | "total" | "ratio";
interface Line {
  id: string;
  label: string;
  level: number;
  kind: Kind;
  monthly: number[];
  total: number;
  actual: number[];
}
interface Driver {
  key: string;
  label: string;
  unit: "pct" | "ils" | "count";
  group: string;
  planValue: number;
  overridden: boolean;
  overrideValue: number | null;
}
interface View {
  scenario: string;
  period: "month" | "quarter" | "year";
  periods: string[];
  lines: Line[];
  chart: { months: string[]; revenue: number[]; ebitda: number[]; netIncome: number[] };
  summary: {
    months: number;
    revenue: number;
    ebitda: number;
    netIncome: number;
    ebitdaMargin: number;
    grossMargin: number;
    peakActiveUnits: number;
  };
  drivers: Driver[];
  overrides: Record<string, number>;
  maxBaselineErrorPct: number;
  actualMonths: number;
  liveActualMonths: number;
}

const fmtC = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}₪${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}₪${(a / 1e3).toFixed(0)}k`;
  return `${s}₪${a.toFixed(0)}`;
};
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const tone = (v: number) => (v >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]");
const inputCls =
  "rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary/50";

export function BridgePanel({ mode = "forecast" }: { mode?: "plan" | "forecast" }) {
  const [period, setPeriod] = useState<"month" | "quarter" | "year">("year");
  const [tableMode, setTableMode] = useState<"plan" | "actual" | "variance">("plan");
  const [data, setData] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: string) => {
      const baseParam = mode === "plan" ? "&base=1" : "";
      const r = await fetch(`/api/bridge?period=${p}${baseParam}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`failed (${r.status})`);
      setData((await r.json()) as View);
    },
    [mode],
  );

  useEffect(() => {
    setLoading(true);
    load(period)
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [period, load]);

  async function postOverride(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/bridge/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`request failed (${r.status})`);
      await load(period);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-xs text-muted-foreground">Loading model…</p>;
  if (error && !data) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const { summary, chart } = data;
  const hasOverrides = Object.keys(data.overrides).length > 0;
  const trend = chart.months.map((m, i) => ({
    label: m,
    Revenue: chart.revenue[i],
    EBITDA: chart.ebitda[i],
    "Net Income": chart.netIncome[i],
  }));

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

      {/* fidelity badge */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant={data.maxBaselineErrorPct < 0.5 ? "success" : "warning"}>
          <BadgeCheck className="h-3 w-3" /> engine reproduces workbook · max Δ{" "}
          {data.maxBaselineErrorPct.toFixed(2)}%
        </Badge>
        <span>
          {data.scenario} · {summary.months} months
        </span>
        {mode === "plan" && <Badge variant="muted">plan of record · read-only</Badge>}
        {hasOverrides && (
          <Badge variant="info">what-if active · {Object.keys(data.overrides).length} driver(s)</Badge>
        )}
      </div>

      {/* summary tiles */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Banknote} label="Revenue (plan)" value={fmtC(summary.revenue)} hint="Sum over horizon" />
        <StatTile
          icon={TrendingUp}
          label="EBITDA (plan)"
          value={fmtC(summary.ebitda)}
          hint={`${fmtPct(summary.ebitdaMargin)} margin`}
          accent={summary.ebitda >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
        <StatTile
          icon={Percent}
          label="Net income (plan)"
          value={fmtC(summary.netIncome)}
          hint={`gross margin ${fmtPct(summary.grossMargin)}`}
          accent={summary.netIncome >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
        <StatTile icon={Building2} label="Peak units" value={summary.peakActiveUnits} hint="Active properties" />
      </section>

      {/* trend chart */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Revenue · EBITDA · Net income</CardTitle>
          <p className="text-[11px] text-muted-foreground">Monthly, across the full plan horizon.</p>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="hsl(215 16% 47%)" interval={5} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="hsl(215 16% 47%)"
                  width={48}
                  tickFormatter={(v: number) => `${(v / 1e6).toFixed(1)}M`}
                />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => fmtC(Number(v) || 0)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="Revenue" stroke="#16a34a" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="EBITDA" stroke="#2563eb" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Net Income" stroke="#e11d48" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* driver what-if editor + actuals slot (forecast only) */}
      {mode === "forecast" && (
        <>
          <DriverEditor
            drivers={data.drivers}
            busy={busy}
            hasOverrides={hasOverrides}
            onSet={(key, value) => postOverride({ key, value })}
            onReset={() => postOverride({ reset: true })}
          />
          <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Actuals &amp; variance:</span> rental-revenue
            actuals are wired live from MiniHotel — booked nights × rate from the ARI sync, summed per
            month — and drop into the Actual column beside the plan. Other lines fill as more
            production data lands.
          </p>
        </>
      )}

      {/* P&L table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>P&amp;L — {data.scenario}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {mode === "forecast" && (
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-[11px]">
                  {(["plan", "actual", "variance"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setTableMode(m)}
                      className={`rounded px-2 py-0.5 capitalize ${
                        tableMode === m ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "variance" ? "Δ vs plan" : m}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-[11px]">
                {(["year", "quarter", "month"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPeriod(p)}
                    className={`rounded px-2 py-0.5 capitalize ${
                      period === p ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {mode === "forecast"
              ? `Plan vs Actual vs variance in one structure — actuals for ${data.actualMonths} month(s)${
                  data.liveActualMonths ? `, incl. ${data.liveActualMonths} live from MiniHotel` : ""
                }; the rest fill from production as it syncs. “·” = no actual yet.`
              : "Driver-derived plan of record. Costs are negative; margins recompute per period."}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-xs tabular-nums">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-card py-2 pr-3 text-left font-medium">Line item</th>
                  {data.periods.map((p) => (
                    <th key={p} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      {p}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((ln) => (
                  <LineRow key={ln.id} ln={ln} mode={mode === "forecast" ? tableMode : "plan"} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LineRow({ ln, mode }: { ln: Line; mode: "plan" | "actual" | "variance" }) {
  const bold = ln.kind === "total" || ln.kind === "subtotal";
  const isTotal = ln.kind === "total";
  const isRatio = ln.kind === "ratio";
  const pad = { paddingLeft: `${0.25 + ln.level * 0.9}rem` };
  const none = { text: "·", cls: "text-muted-foreground/40" };

  // What each period cell shows, given the active Plan / Actual / Variance mode.
  const cell = (i: number): { text: string; cls: string } => {
    const plan = ln.monthly[i];
    const act = ln.actual[i] ?? 0;
    if (isRatio) return { text: mode === "plan" ? fmtPct(plan) : "", cls: "" };
    if (mode === "plan") return { text: fmtC(plan), cls: isTotal ? tone(plan) : "" };
    if (act === 0) return none; // no actual reported for this period
    if (mode === "actual") return { text: fmtC(act), cls: isTotal ? tone(act) : "" };
    const v = act - plan;
    return { text: `${v >= 0 ? "+" : ""}${fmtC(v)}`, cls: tone(v) };
  };

  // Row total: for actual/variance, sum only over periods that have an actual.
  const totalCell = (): { text: string; cls: string } => {
    if (isRatio) return { text: "", cls: "" };
    if (mode === "plan") return { text: fmtC(ln.total), cls: isTotal ? tone(ln.total) : "" };
    let aSum = 0;
    let pSum = 0;
    let any = false;
    ln.actual.forEach((a, i) => {
      if (a !== 0) {
        aSum += a;
        pSum += ln.monthly[i];
        any = true;
      }
    });
    if (!any) return none;
    if (mode === "actual") return { text: fmtC(aSum), cls: isTotal ? tone(aSum) : "" };
    const v = aSum - pSum;
    return { text: `${v >= 0 ? "+" : ""}${fmtC(v)}`, cls: tone(v) };
  };

  const t = totalCell();
  return (
    <tr
      className={`border-b border-border/40 ${isTotal ? "border-t border-border bg-muted/20" : ""} ${
        bold ? "font-semibold" : ""
      } ${isRatio ? "text-muted-foreground" : ""}`}
    >
      <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 text-left" style={pad}>
        {ln.label}
      </td>
      {ln.monthly.map((_, i) => {
        const c = cell(i);
        return (
          <td key={i} className={`px-2 py-1.5 text-right ${c.cls}`}>
            {c.text}
          </td>
        );
      })}
      <td className={`px-2 py-1.5 text-right ${bold ? "" : "text-muted-foreground"} ${t.cls}`}>{t.text}</td>
    </tr>
  );
}

function DriverEditor({
  drivers,
  busy,
  hasOverrides,
  onSet,
  onReset,
}: {
  drivers: Driver[];
  busy: boolean;
  hasOverrides: boolean;
  onSet: (key: string, value: number | null) => void;
  onReset: () => void;
}) {
  const groups = Array.from(new Set(drivers.map((d) => d.group)));
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>What-if drivers</CardTitle>
          {hasOverrides && (
            <button
              type="button"
              disabled={busy}
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" /> Reset to plan
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Override a driver to hold it flat across the horizon and recompute the whole P&amp;L. Blank = plan.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">{g}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {drivers.filter((d) => d.group === g).map((d) => (
                <DriverInput key={d.key} d={d} busy={busy} onSet={onSet} />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DriverInput({
  d,
  busy,
  onSet,
}: {
  d: Driver;
  busy: boolean;
  onSet: (key: string, value: number | null) => void;
}) {
  const toDisplay = (v: number) => (d.unit === "pct" ? v * 100 : v);
  const fromDisplay = (v: number) => (d.unit === "pct" ? v / 100 : v);
  const planDisp = toDisplay(d.planValue);
  const [val, setVal] = useState(d.overrideValue != null ? String(round(toDisplay(d.overrideValue))) : "");

  useEffect(() => {
    setVal(d.overrideValue != null ? String(round(toDisplay(d.overrideValue))) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.overrideValue]);

  const suffix = d.unit === "pct" ? "%" : d.unit === "ils" ? "₪" : "";
  return (
    <label
      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
        d.overridden ? "border-primary/40 bg-primary/5" : "border-border/70 bg-background/40"
      }`}
    >
      <span className="truncate text-[11px] text-muted-foreground" title={d.label}>
        {d.label}
      </span>
      <span className="flex items-center gap-1">
        <input
          className={`${inputCls} w-16 text-right`}
          value={val}
          placeholder={`${round(planDisp)}${suffix}`}
          disabled={busy}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const t = val.trim();
            if (t === "") {
              if (d.overridden) onSet(d.key, null);
              return;
            }
            const num = parseFloat(t);
            if (Number.isFinite(num)) onSet(d.key, fromDisplay(num));
          }}
        />
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </span>
    </label>
  );
}

function round(v: number) {
  if (Math.abs(v) >= 100) return Math.round(v);
  return Math.round(v * 100) / 100;
}
