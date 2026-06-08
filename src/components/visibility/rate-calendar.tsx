"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
  Loader2,
  Lock,
  Percent,
  RefreshCw,
  Save,
  TrendingUp,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatTile } from "@/components/stat-tile";

interface RateCell {
  date: string;
  price: number;
  available: number;
  minNights: number;
  closed: boolean;
  booked: boolean;
  weekend: boolean;
  source: "derived" | "manual" | "minihotel";
}
interface RateRow {
  unit: {
    id: string;
    name: string;
    neighborhood: string;
    bedrooms: number;
    platform: string;
    currentRate: number;
    baseRate: number;
  };
  cells: RateCell[];
}
interface Calendar {
  from: string;
  days: number;
  dates: string[];
  currency: string;
  defaultMinNights: number;
  rows: RateRow[];
  summary: {
    units: number;
    windowDays: number;
    occupancy: number;
    adr: number;
    bookedRevenue: number;
    sold: number;
    open: number;
    closed: number;
  };
}

const HORIZONS = [21, 35, 60, 90];
const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const inputCls =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";
const iconBtn =
  "inline-flex items-center justify-center rounded-md border border-border bg-card h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-card h-8 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50";

const fmtILS = (n: number) => "₪" + Math.round(n).toLocaleString("en-US");
const todayUTC = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const partsUTC = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return { wd: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth(), year: d.getUTCFullYear() };
};

export function RateCalendar() {
  const [from, setFrom] = useState(todayUTC());
  const [days, setDays] = useState(35);
  const [hood, setHood] = useState("all");
  const [data, setData] = useState<Calendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ unitId: string; date: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/rates?from=${from}&days=${days}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`failed to load (${r.status})`);
    setData((await r.json()) as Calendar);
  }, [from, days]);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [refresh]);

  const hoods = useMemo(() => {
    const s = new Set((data?.rows ?? []).map((r) => r.unit.neighborhood));
    return ["all", ...Array.from(s).sort()];
  }, [data]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => hood === "all" || r.unit.neighborhood === hood),
    [data, hood],
  );

  const selCell = useMemo(() => {
    if (!sel || !data) return null;
    const row = data.rows.find((r) => r.unit.id === sel.unitId);
    const cell = row?.cells.find((c) => c.date === sel.date);
    return row && cell ? { unit: row.unit, cell } : null;
  }, [sel, data]);

  async function save(body: { unitId: string; date: string; price: number; minNights: number; closed: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  async function syncMiniHotel() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/rates/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, days }),
      });
      const d = (await r.json()) as {
        ok: boolean;
        written?: number;
        mappedTypes?: number;
        unmappedTypes?: string[];
        message?: string;
      };
      if (d.ok) {
        const extra = d.unmappedTypes && d.unmappedTypes.length ? ` · unmapped: ${d.unmappedTypes.join(", ")}` : "";
        setSyncMsg({ ok: true, text: `Synced ${d.written ?? 0} nights across ${d.mappedTypes ?? 0} room type(s)${extra}.` });
        await refresh();
      } else {
        setSyncMsg({ ok: false, text: d.message || "Sync failed." });
      }
    } catch (e) {
      setSyncMsg({ ok: false, text: e instanceof Error ? e.message : "sync failed" });
    } finally {
      setSyncing(false);
    }
  }

  if (loading) return <p className="text-xs text-muted-foreground">Loading rates…</p>;
  if (error && !data) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const last = data.dates[data.dates.length - 1] ?? from;
  const a = partsUTC(from);
  const b = partsUTC(last);
  const rangeLabel = `${MON[a.mon]} ${a.day} – ${MON[b.mon]} ${b.day}, ${b.year}`;
  const s = data.summary;

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

      {/* summary tiles */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Percent}
          label={`Occupancy · ${s.windowDays}d`}
          value={`${(s.occupancy * 100).toFixed(0)}%`}
          hint={`${s.sold} sold · ${s.open} open nights`}
          accent="text-[hsl(var(--success))]"
        />
        <StatTile icon={Banknote} label={`ADR · ${s.windowDays}d`} value={fmtILS(s.adr)} hint="Avg booked nightly rate" />
        <StatTile
          icon={TrendingUp}
          label={`On-the-books · ${s.windowDays}d`}
          value={fmtILS(s.bookedRevenue)}
          hint="Revenue from sold nights"
        />
        <StatTile
          icon={CalendarDays}
          label="Listings"
          value={s.units}
          hint={`${s.closed} closed night${s.closed === 1 ? "" : "s"} in window`}
          accent="text-[hsl(var(--warning))]"
        />
      </section>

      {/* controls */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            From
            <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value || todayUTC())} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Horizon
            <select className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {h} days
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Neighborhood
            <select className={inputCls} value={hood} onChange={(e) => setHood(e.target.value)}>
              {hoods.map((h) => (
                <option key={h} value={h}>
                  {h === "all" ? "All neighborhoods" : h}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1.5">
            <button className={iconBtn} title="Back a week" onClick={() => setFrom((f) => addDays(f, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button className={`${inputCls} h-8`} onClick={() => setFrom(todayUTC())}>
              Today
            </button>
            <button className={iconBtn} title="Forward a week" onClick={() => setFrom((f) => addDays(f, 7))}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button className={iconBtn} title="Refresh" disabled={busy} onClick={() => refresh().catch(() => undefined)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            className={btnGhost}
            title="Pull live prices & availability from MiniHotel into this calendar"
            disabled={syncing}
            onClick={syncMiniHotel}
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            Sync MiniHotel
          </button>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <LegendSwatch className="bg-card border border-border" label="Open" />
            <LegendSwatch className="bg-success/15" label="Booked" />
            <LegendSwatch className="bg-danger/10" label="Closed" />
            <LegendSwatch className="bg-muted/60" label="Weekend" />
          </div>
        </CardContent>
      </Card>

      {syncMsg && (
        <p
          className={`text-[11px] ${
            syncMsg.ok ? "text-[hsl(var(--success))]" : "text-[hsl(var(--warning))]"
          }`}
        >
          {syncMsg.text}
        </p>
      )}

      {/* edit bar */}
      {selCell && (
        <EditBar
          key={`${selCell.unit.id}|${selCell.cell.date}`}
          unitName={selCell.unit.name}
          cell={selCell.cell}
          defaultMinNights={data.defaultMinNights}
          busy={busy}
          onClose={() => setSel(null)}
          onSave={(price, minNights, closed) =>
            save({ unitId: selCell.unit.id, date: selCell.cell.date, price, minNights, closed })
          }
        />
      )}

      {/* the multi-calendar grid */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Multi-calendar — {rangeLabel}</CardTitle>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {data.currency} · nightly · {rows.length} listings × {data.days} nights
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Click any night to edit its rate, minimum-stay, or close it. Edits are staged locally —
            wiring the push to MiniHotel (Reverse ARI) is the next step.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="border-collapse text-[11px] tabular-nums">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-card px-3 py-2 text-left font-medium text-muted-foreground min-w-[12rem]">
                    Listing
                  </th>
                  {data.dates.map((d) => {
                    const p = partsUTC(d);
                    const monthStart = p.day === 1;
                    return (
                      <th
                        key={d}
                        className={`px-1 py-1 text-center font-medium w-14 ${
                          p.wd === 5 || p.wd === 6 ? "bg-muted/40" : ""
                        } ${monthStart ? "border-l border-border" : ""}`}
                      >
                        <div className="text-[9px] uppercase text-muted-foreground">{WD[p.wd]}</div>
                        <div className="text-foreground">{p.day}</div>
                        {monthStart && (
                          <div className="text-[8px] uppercase tracking-wide text-primary">{MON[p.mon]}</div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.unit.id} className="border-t border-border/50">
                    <th className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left align-middle min-w-[12rem]">
                      <div className="font-medium text-foreground leading-tight">{row.unit.name}</div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span>{row.unit.neighborhood}</span>
                        <Badge variant="muted">{row.unit.platform}</Badge>
                        <span>₪{row.unit.currentRate}</span>
                      </div>
                    </th>
                    {row.cells.map((c) => {
                      const selected = sel?.unitId === row.unit.id && sel?.date === c.date;
                      const monthStart = partsUTC(c.date).day === 1;
                      return (
                        <td key={c.date} className={`p-0 ${monthStart ? "border-l border-border" : ""}`}>
                          <button
                            type="button"
                            onClick={() => setSel({ unitId: row.unit.id, date: c.date })}
                            className={`relative h-11 w-14 px-1 leading-tight transition-colors ${cellTone(c)} ${
                              selected ? "ring-2 ring-primary ring-inset" : "hover:brightness-95"
                            }`}
                            title={`${row.unit.name} · ${c.date}${c.closed ? " · closed" : c.booked ? " · booked" : ""} · min ${c.minNights}n${
                              c.source !== "derived" ? ` · ${c.source}` : ""
                            }`}
                          >
                            <div className="font-medium">
                              {c.closed ? <Lock className="mx-auto h-3 w-3" /> : c.price}
                            </div>
                            <div className="text-[9px] text-muted-foreground">
                              {c.booked ? "sold" : c.closed ? "" : c.minNights !== data.defaultMinNights ? `≥${c.minNights}` : ""}
                            </div>
                            {c.source !== "derived" && (
                              <span
                                className={`absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${
                                  c.source === "minihotel" ? "bg-info" : "bg-primary"
                                }`}
                              />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Baseline is computed from each listing&apos;s rate &amp; occupancy. A dot marks an
            override: <span className="text-primary">●</span> manual edit ·{" "}
            <span className="text-info">●</span> synced from MiniHotel.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function cellTone(c: RateCell): string {
  if (c.closed) return "bg-danger/10 text-muted-foreground";
  if (c.booked) return "bg-success/15 text-foreground";
  if (c.weekend) return "bg-muted/50 text-foreground";
  return "bg-card text-foreground";
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

function EditBar({
  unitName,
  cell,
  defaultMinNights,
  busy,
  onSave,
  onClose,
}: {
  unitName: string;
  cell: RateCell;
  defaultMinNights: number;
  busy: boolean;
  onSave: (price: number, minNights: number, closed: boolean) => void;
  onClose: () => void;
}) {
  const [price, setPrice] = useState(String(cell.price));
  const [minNights, setMinNights] = useState(String(cell.minNights));
  const [closed, setClosed] = useState(cell.closed);
  const num = (s: string, d: number) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : d;
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
        <div className="mr-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Editing</div>
          <div className="text-sm font-medium">
            {unitName} · {cell.date}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {cell.booked && <Badge variant="success">booked</Badge>}
            {cell.source !== "derived" && <Badge variant="info">{cell.source}</Badge>}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Nightly rate (₪)
          <input className={`${inputCls} w-28`} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Min nights
          <input className={`${inputCls} w-24`} value={minNights} onChange={(e) => setMinNights(e.target.value)} inputMode="numeric" />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--danger))]" />
          Close this night
        </label>
        <button
          type="button"
          disabled={busy}
          className={btnCls}
          onClick={() => onSave(Math.max(0, num(price, cell.price)), Math.max(1, num(minNights, defaultMinNights)), closed)}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
        <button type="button" className={`${iconBtn} ml-auto`} title="Close editor" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </CardContent>
    </Card>
  );
}
