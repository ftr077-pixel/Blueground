"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Banknote,
  Loader2,
  Percent,
  Plus,
  Trash2,
  TrendingUp,
  Wallet,
} from "lucide-react";
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

interface PnlMonth {
  key: string;
  label: string;
}
interface PnlRow {
  id: string;
  label: string;
  section: string;
  category: "revenue" | "cost";
  kind: "derived" | "manual";
  editable: boolean;
  monthly: number[];
  total: number;
  note?: string;
  lineId?: string;
  base?: number;
  growthPct?: number;
}
interface Forecast {
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
  assumptions: {
    horizonMonths: number;
    revenueGrowthPct: number;
    costGrowthPct: number;
    mgmtFeePct: number;
  };
  basis: {
    units: number;
    monthlyDerivedRevenue: number;
    monthlyDerivedDirectCost: number;
    costLinesEntered: boolean;
  };
}

const inputCls =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

const fmtILS = (n: number) => "₪" + Math.round(n).toLocaleString("en-US");
const fmtSigned = (n: number) => (n < 0 ? "-₪" : "₪") + Math.round(Math.abs(n)).toLocaleString("en-US");
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function PnlPanel() {
  const [data, setData] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/pnl", { cache: "no-store" });
    if (!r.ok) throw new Error(`failed to load (${r.status})`);
    setData((await r.json()) as Forecast);
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [refresh]);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || `request failed (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-xs text-muted-foreground">Loading forecast…</p>;
  if (error && !data) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const { months, rows, summary } = data;
  const chart = months.map((m, i) => ({
    label: m.label,
    revenue: Math.round(data.revenueByMonth[i]),
    cost: Math.round(data.costByMonth[i]),
    net: Math.round(data.netByMonth[i]),
  }));
  const revenueRows = rows.filter((r) => r.category === "revenue");
  const costRows = rows.filter((r) => r.category === "cost");

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

      {/* -------------------------------------------------- summary tiles */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Banknote}
          label="Revenue / mo"
          value={fmtILS(summary.monthlyRevenue)}
          hint={`${summary.units} units · this month`}
        />
        <StatTile
          icon={Wallet}
          label="Costs / mo"
          value={fmtILS(summary.monthlyCost)}
          hint="Direct + operating"
          accent="text-[hsl(var(--warning))]"
        />
        <StatTile
          icon={TrendingUp}
          label="Net / mo"
          value={fmtSigned(summary.monthlyNet)}
          hint={`${summary.horizonMonths}-mo net ${fmtSigned(summary.annualNet)}`}
          accent={summary.monthlyNet >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
        <StatTile
          icon={Percent}
          label="Net margin"
          value={fmtPct(summary.margin)}
          hint={`on ${fmtILS(summary.annualRevenue)} / yr`}
          accent={summary.margin >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
      </section>

      {!data.basis.costLinesEntered && (
        <p className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-[11px] text-muted-foreground">
          No costs entered yet, so margin reads high. Add per-apartment rent/utilities/cleaning in{" "}
          <span className="font-medium">Search Visibility → Manage</span>, or add operating lines
          (arnona, accounting, insurance, software) in the table below.
        </p>
      )}

      {/* -------------------------------------------------- forecast chart */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Forecast — revenue, cost &amp; net</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Projected monthly P&amp;L across the next {summary.horizonMonths} months. Revenue tracks
            live unit rates &amp; occupancy; costs come from your apartment costs and operating lines.
          </p>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="hsl(215 16% 47%)"
                  width={64}
                  tickFormatter={(v: number) => `₪${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(v) => fmtILS(Number(v) || 0)}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#16a34a" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="cost" name="Costs" stroke="#e11d48" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="net" name="Net" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* -------------------------------------------------- assumptions */}
      <AssumptionsCard busy={busy} onSave={(patch) => call("/api/pnl/settings", "POST", patch)} />

      {/* -------------------------------------------------- P&L table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Monthly P&amp;L</CardTitle>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              ILS · {months.length} months
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Derived rows update automatically. Operating lines are editable — set a base monthly
            amount and optional monthly growth.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-xs tabular-nums">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-card py-2 pr-3 text-left font-medium">
                    Line item
                  </th>
                  {months.map((m) => (
                    <th key={m.key} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      {m.label}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-semibold whitespace-nowrap">Total</th>
                </tr>
              </thead>
              <tbody>
                <SectionLabel cols={months.length + 2} text="Revenue" />
                {revenueRows.map((r) => (
                  <LineRow key={r.id} row={r} busy={busy} onPatch={call} />
                ))}
                <TotalRow label="Total revenue" values={data.revenueByMonth} total={summary.annualRevenue} tone="revenue" />

                <SectionLabel cols={months.length + 2} text="Costs" />
                {costRows.length === 0 && (
                  <tr>
                    <td colSpan={months.length + 2} className="py-2 pr-3 text-[11px] text-muted-foreground">
                      No costs yet — add operating lines below.
                    </td>
                  </tr>
                )}
                {costRows.map((r) => (
                  <LineRow key={r.id} row={r} busy={busy} onPatch={call} />
                ))}
                <TotalRow label="Total costs" values={data.costByMonth} total={summary.annualCost} tone="cost" />

                <tr className="border-t-2 border-border font-semibold">
                  <td className="sticky left-0 z-10 bg-card py-2 pr-3 text-left">Net operating income</td>
                  {data.netByMonth.map((v, i) => (
                    <td
                      key={i}
                      className={`px-2 py-2 text-right ${v >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}`}
                    >
                      {fmtSigned(v)}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right">{fmtSigned(summary.annualNet)}</td>
                </tr>
                <tr className="text-muted-foreground">
                  <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 text-left">Margin</td>
                  {data.marginByMonth.map((v, i) => (
                    <td key={i} className="px-2 py-1.5 text-right">
                      {fmtPct(v)}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">{fmtPct(summary.margin)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <AddLineForm busy={busy} onAdd={(body) => call("/api/pnl/lines", "POST", body)} />
        </CardContent>
      </Card>
    </div>
  );
}

function SectionLabel({ text, cols }: { text: string; cols: number }) {
  return (
    <tr>
      <td
        colSpan={cols}
        className="sticky left-0 bg-card pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {text}
      </td>
    </tr>
  );
}

function TotalRow({
  label,
  values,
  total,
  tone,
}: {
  label: string;
  values: number[];
  total: number;
  tone: "revenue" | "cost";
}) {
  return (
    <tr className="border-t border-border/70 font-medium">
      <td className="sticky left-0 z-10 bg-card py-2 pr-3 text-left">{label}</td>
      {values.map((v, i) => (
        <td key={i} className="px-2 py-2 text-right">
          {tone === "cost" ? `(${fmtILS(v)})` : fmtILS(v)}
        </td>
      ))}
      <td className="px-2 py-2 text-right">{tone === "cost" ? `(${fmtILS(total)})` : fmtILS(total)}</td>
    </tr>
  );
}

function LineRow({
  row,
  busy,
  onPatch,
}: {
  row: PnlRow;
  busy: boolean;
  onPatch: (url: string, method: string, body?: unknown) => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [base, setBase] = useState(row.base != null ? String(row.base) : "");
  const [growth, setGrowth] = useState(row.growthPct ? String(row.growthPct) : "");
  const num = (s: string) => {
    const n = parseFloat(s);
    return s.trim() && Number.isFinite(n) ? n : 0;
  };
  const url = row.lineId ? `/api/pnl/lines/${row.lineId}` : "";

  return (
    <tr className="border-b border-border/40">
      <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 text-left align-top">
        {row.editable ? (
          <div className="flex flex-col gap-1">
            <input
              className={`${inputCls} w-44`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                if (label.trim() && label.trim() !== row.label) onPatch(url, "PATCH", { label: label.trim() });
              }}
            />
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>₪</span>
              <input
                className={`${inputCls} w-20 px-1.5 py-1`}
                value={base}
                placeholder="0"
                title="Base monthly amount"
                onChange={(e) => setBase(e.target.value)}
                onBlur={() => onPatch(url, "PATCH", { monthlyAmount: num(base) })}
              />
              <span>/mo ·</span>
              <input
                className={`${inputCls} w-12 px-1.5 py-1`}
                value={growth}
                placeholder="0"
                title="Monthly growth %"
                onChange={(e) => setGrowth(e.target.value)}
                onBlur={() => onPatch(url, "PATCH", { growthPct: num(growth) })}
              />
              <span>% g</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPatch(url, "DELETE")}
                title="Remove line"
                className="ml-1 text-muted-foreground hover:text-[hsl(var(--danger))]"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <span className="font-medium text-foreground">{row.label}</span>
            {row.note && <span className="text-[10px] text-muted-foreground">{row.note}</span>}
          </div>
        )}
      </td>
      {row.monthly.map((v, i) => (
        <td key={i} className="px-2 py-1.5 text-right text-muted-foreground align-top">
          {row.category === "cost" ? `(${fmtILS(v)})` : fmtILS(v)}
        </td>
      ))}
      <td className="px-2 py-1.5 text-right align-top">
        {row.category === "cost" ? `(${fmtILS(row.total)})` : fmtILS(row.total)}
      </td>
    </tr>
  );
}

function AssumptionsCard({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (patch: Record<string, number>) => void;
}) {
  const [horizon, setHorizon] = useState("12");
  const [revG, setRevG] = useState("0");
  const [costG, setCostG] = useState("0");
  const [mgmt, setMgmt] = useState("0");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/pnl/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { horizonMonths: number; revenueGrowthPct: number; costGrowthPct: number; mgmtFeePct: number }) => {
        setHorizon(String(s.horizonMonths));
        setRevG(String(s.revenueGrowthPct));
        setCostG(String(s.costGrowthPct));
        setMgmt(String(s.mgmtFeePct));
      })
      .catch(() => undefined);
  }, []);

  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Assumptions</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Drives the projection. Growth compounds per month; the management fee is booked as a cost
          on gross revenue.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 text-[11px] text-muted-foreground">
          <label className="flex flex-col gap-1">
            Horizon (months)
            <input className={`${inputCls} w-24`} value={horizon} onChange={(e) => setHorizon(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Revenue growth %/mo
            <input className={`${inputCls} w-24`} value={revG} onChange={(e) => setRevG(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Cost growth %/mo
            <input className={`${inputCls} w-24`} value={costG} onChange={(e) => setCostG(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Management fee % of rev
            <input className={`${inputCls} w-24`} value={mgmt} onChange={(e) => setMgmt(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy}
            className={btnCls}
            onClick={() => {
              onSave({
                horizonMonths: Math.round(num(horizon)) || 12,
                revenueGrowthPct: num(revG),
                costGrowthPct: num(costG),
                mgmtFeePct: num(mgmt),
              });
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
          >
            {saved ? "Saved ✓" : "Apply"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function AddLineForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (body: Record<string, unknown>) => void;
}) {
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<"cost" | "revenue">("cost");
  const [amount, setAmount] = useState("");
  const [growth, setGrowth] = useState("");

  return (
    <div className="mt-4 rounded-lg border border-dashed border-border p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Add line
        <Badge variant="muted">operating costs &amp; extra revenue</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} w-52`}
          placeholder="e.g. Arnona, Accounting, Insurance"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <select
          className={inputCls}
          value={category}
          onChange={(e) => setCategory(e.target.value as "cost" | "revenue")}
        >
          <option value="cost">Cost</option>
          <option value="revenue">Revenue</option>
        </select>
        <input
          className={`${inputCls} w-28`}
          placeholder="₪ / month"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className={`${inputCls} w-24`}
          placeholder="growth %/mo"
          value={growth}
          onChange={(e) => setGrowth(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !label.trim()}
          className={btnCls}
          onClick={() => {
            onAdd({
              label: label.trim(),
              category,
              monthlyAmount: parseFloat(amount) || 0,
              growthPct: parseFloat(growth) || 0,
            });
            setLabel("");
            setAmount("");
            setGrowth("");
          }}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add
        </button>
      </div>
    </div>
  );
}
