"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, CalendarCheck, Loader2, Percent, Settings2, TrendingUp, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatTile } from "@/components/stat-tile";

// ----------------------------------------------------------- response mirror
interface OpsMonth {
  key: string;
  label: string;
  phase: "past" | "current" | "future";
  openDays: number;
}
interface OpsRow {
  id: string;
  label: string;
  section: string;
  kind: "line" | "subtotal" | "total" | "ratio" | "count";
  monthly: number[];
  total: number;
  note?: string;
}
interface OpsAssumptions {
  horizonMonths: number;
  historyMonths: number;
  targetOccupancyPct: number;
  expectedAdr: number;
  avgStayNights: number;
  sellableUnits: number;
  cleaningPerCheckout: number;
  laundryPerCheckout: number;
  suppliesPerCheckout: number;
  repairsPerUnitMonth: number;
  avgRepairCost: number;
  rentPerUnitMonth: number;
  utilitiesPerUnitMonth: number;
  salariesMonthly: number;
  otherFixedMonthly: number;
  ownerSharePct: number;
  mgmtFeePct: number;
}
interface OpsForecast {
  today: string;
  currency: string;
  months: OpsMonth[];
  rows: OpsRow[];
  summary: {
    units: number;
    horizonMonths: number;
    forwardRevenue: number;
    forwardCost: number;
    forwardNet: number;
    forwardMargin: number;
    onTheBooks: number;
    expectedPickup: number;
    planRevenue: number;
    planDelta: number;
  };
  assumptions: OpsAssumptions;
  derived: {
    units: number;
    unitsSource: string;
    adr: number;
    adrSource: string;
    avgStay: number;
    avgStaySource: string;
    rentMonthly: number;
    rentSource: string;
    utilitiesMonthly: number;
    utilitiesSource: string;
    reservations: number;
  };
}

const fmtC = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}₪${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}₪${(a / 1e3).toFixed(0)}k`;
  return `${s}₪${Math.round(a)}`;
};
const tone = (v: number) => (v >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]");
const inputCls =
  "w-24 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary/50";

// Every knob, grouped the way the operator thinks about the business.
const FIELDS: Array<{
  group: string;
  hint: string;
  items: Array<{ key: keyof OpsAssumptions; label: string; suffix?: string; auto?: string }>;
}> = [
  {
    group: "How we sell",
    hint: "Drives the revenue we don't hold yet.",
    items: [
      { key: "targetOccupancyPct", label: "Target occupancy", suffix: "%" },
      { key: "expectedAdr", label: "Expected ADR (net)", suffix: "₪", auto: "realized ADR" },
      { key: "avgStayNights", label: "Average stay", suffix: "nights", auto: "realized" },
      { key: "sellableUnits", label: "Sellable apartments", auto: "PMS inventory" },
    ],
  },
  {
    group: "Per checkout",
    hint: "Charged once per turnover — the model counts checkouts from the real bookings.",
    items: [
      { key: "cleaningPerCheckout", label: "Cleaning", suffix: "₪" },
      { key: "laundryPerCheckout", label: "Laundry", suffix: "₪" },
      { key: "suppliesPerCheckout", label: "Consumables", suffix: "₪" },
    ],
  },
  {
    group: "Repairs",
    hint: "Expected repairs per apartment per month × what a repair costs.",
    items: [
      { key: "repairsPerUnitMonth", label: "Repairs / apt / month", suffix: "×" },
      { key: "avgRepairCost", label: "Cost per repair", suffix: "₪" },
    ],
  },
  {
    group: "Per apartment / month",
    hint: "Leave at 0 to use the rent and utilities set per listing in Manage.",
    items: [
      { key: "rentPerUnitMonth", label: "Rent", suffix: "₪", auto: "from listings" },
      { key: "utilitiesPerUnitMonth", label: "Utilities", suffix: "₪", auto: "from listings" },
    ],
  },
  {
    group: "Fixed monthly",
    hint: "Costs that don't move with occupancy.",
    items: [
      { key: "salariesMonthly", label: "Salaries", suffix: "₪" },
      { key: "otherFixedMonthly", label: "Other fixed", suffix: "₪" },
    ],
  },
  {
    group: "Shares of revenue",
    hint: "Anything paid as a percentage of what we bill.",
    items: [
      { key: "ownerSharePct", label: "Owner / partner share", suffix: "%" },
      { key: "mgmtFeePct", label: "Management fee", suffix: "%" },
    ],
  },
  {
    group: "Window",
    hint: "How many months the table covers.",
    items: [
      { key: "historyMonths", label: "Months of history", suffix: "m" },
      { key: "horizonMonths", label: "Months ahead", suffix: "m" },
    ],
  },
];

const SECTIONS = ["Revenue", "Costs", "Result", "vs Plan", "Drivers"] as const;

export function OpsForecastPanel() {
  const [data, setData] = useState<OpsForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSettings, setOpenSettings] = useState(false);
  // Local edit buffer so typing doesn't fire a request per keystroke.
  const [draft, setDraft] = useState<Partial<Record<keyof OpsAssumptions, string>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pnl/ops-forecast", { cache: "no-store" });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      setData((await res.json()) as OpsForecast);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const patch: Partial<OpsAssumptions> = {};
    for (const [k, v] of Object.entries(draft)) {
      const n = parseFloat(v ?? "");
      if (Number.isFinite(n)) patch[k as keyof OpsAssumptions] = n;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pnl/ops-forecast", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      setData((await res.json()) as OpsForecast);
      setDraft({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  const valueOf = (k: keyof OpsAssumptions) =>
    draft[k] ?? String(data?.assumptions[k] ?? 0);

  const bySection = useMemo(() => {
    const m = new Map<string, OpsRow[]>();
    for (const r of data?.rows ?? []) {
      const list = m.get(r.section) ?? [];
      list.push(r);
      m.set(r.section, list);
    }
    return m;
  }, [data]);

  if (loading && !data) {
    return (
      <Card className="grid h-40 place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card className="p-4">
        <p className="text-sm text-[hsl(var(--danger))]">{error ?? "No forecast available."}</p>
      </Card>
    );
  }

  const s = data.summary;
  const d = data.derived;
  const fwdMonths = data.months.filter((m) => m.phase !== "past").length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Operating forecast</h2>
        <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
          Built bottom-up from what we already hold, not from the workbook:{" "}
          <b>revenue already sold</b> (MiniHotel reservations, VAT-net, accrued per night){" "}
          <b>+ expected pickup</b> on the nights still open, costed with your real unit economics —
          cleaning, laundry and consumables per checkout (counted from the bookings themselves),
          repairs, salaries, rent and revenue shares. The <b>Bridge 11 m plan above stays
          untouched</b>; the “vs Plan” rows show how this lands against it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Projected revenue · ${fwdMonths}m`}
          value={fmtC(s.forwardRevenue)}
          hint={`${fmtC(s.onTheBooks)} sold + ${fmtC(s.expectedPickup)} pickup`}
          icon={Banknote}
        />
        <StatTile
          label="Projected costs"
          value={fmtC(s.forwardCost)}
          hint={`${s.units} apartments`}
          icon={Wallet}
          accent="text-[hsl(var(--danger))]"
        />
        <StatTile
          label="Net result"
          value={fmtC(s.forwardNet)}
          hint={`${(s.forwardMargin * 100).toFixed(1)}% margin`}
          icon={TrendingUp}
          accent={s.forwardNet >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
        <StatTile
          label="vs Bridge plan"
          value={`${s.planDelta >= 0 ? "+" : ""}${fmtC(s.planDelta)}`}
          hint={`plan rental revenue ${fmtC(s.planRevenue)}`}
          icon={Percent}
          accent={s.planDelta >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
        />
      </div>

      {/* ------------------------------------------------------- assumptions */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" /> Operating parameters
            </CardTitle>
            <div className="flex items-center gap-2">
              {(Object.keys(draft).length > 0 || saving) && (
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {saving ? "Saving…" : "Apply"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpenSettings((o) => !o)}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/50"
              >
                {openSettings ? "Hide" : "Edit"}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {d.units} apartments ({d.unitsSource}) · ADR ₪{Math.round(d.adr)} ({d.adrSource}) ·
            average stay {d.avgStay.toFixed(1)} nights ({d.avgStaySource}) · rent{" "}
            {fmtC(d.rentMonthly)}/mo ({d.rentSource}) · {d.reservations} reservations on file. A
            field left at <b>0</b> is derived from your own data where that's possible.
          </p>
        </CardHeader>
        {openSettings && (
          <CardContent>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {FIELDS.map((g) => (
                <div key={g.group}>
                  <div className="text-[11px] font-medium">{g.group}</div>
                  <div className="mb-2 text-[10px] text-muted-foreground">{g.hint}</div>
                  <div className="space-y-1.5">
                    {g.items.map((f) => (
                      <label key={f.key} className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {f.label}
                          {f.auto && Number(valueOf(f.key)) === 0 && (
                            <span className="ml-1 text-[10px] text-primary">auto: {f.auto}</span>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            step="any"
                            className={inputCls}
                            value={valueOf(f.key)}
                            onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") save();
                            }}
                          />
                          {f.suffix && (
                            <span className="w-10 text-[10px] text-muted-foreground">{f.suffix}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ------------------------------------------------------------- table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Month by month</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Shaded months are already elapsed — their revenue is what actually happened; costs are
            still modelled (MiniHotel carries no cost data). The current month picks up only over
            its remaining days.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-xs tabular-nums">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-card py-2 pr-3 text-left font-medium">
                    Line item
                  </th>
                  {data.months.map((m) => (
                    <th
                      key={m.key}
                      className={`whitespace-nowrap px-2 py-2 text-right font-medium ${
                        m.phase === "past" ? "text-muted-foreground/60" : ""
                      } ${m.phase === "current" ? "text-primary" : ""}`}
                    >
                      {m.label}
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-2 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {SECTIONS.map((section) => {
                  const rows = bySection.get(section);
                  if (!rows?.length) return null;
                  return (
                    <Fragment key={section}>
                      <tr className="border-b border-border/60">
                        <td
                          colSpan={data.months.length + 2}
                          className="sticky left-0 bg-card pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {section}
                        </td>
                      </tr>
                      {rows.map((r) => (
                        <Row key={r.id} row={r} months={data.months} />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}
    </div>
  );
}

function Row({ row, months }: { row: OpsRow; months: OpsMonth[] }) {
  const bold = row.kind === "total" || row.kind === "subtotal";
  const isDelta = row.id.includes("delta");
  const fmt = (v: number) => {
    if (row.kind === "ratio") return `${v.toFixed(1)}%`;
    if (row.kind === "count") return Math.round(v).toLocaleString();
    return fmtC(v);
  };
  return (
    <tr className={`border-b border-border/40 ${bold ? "font-semibold" : ""}`}>
      <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 text-left">
        {row.label}
        {row.note && (
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{row.note}</span>
        )}
      </td>
      {row.monthly.map((v, i) => (
        <td
          key={months[i]?.key ?? i}
          className={`px-2 py-1.5 text-right ${
            months[i]?.phase === "past" ? "bg-muted/30 text-muted-foreground" : ""
          } ${isDelta ? tone(v) : ""}`}
        >
          {isDelta && v > 0 ? "+" : ""}
          {fmt(v)}
        </td>
      ))}
      <td className={`px-2 py-1.5 text-right font-semibold ${isDelta ? tone(row.total) : ""}`}>
        {row.kind === "ratio" ? "—" : fmt(row.total)}
      </td>
    </tr>
  );
}
