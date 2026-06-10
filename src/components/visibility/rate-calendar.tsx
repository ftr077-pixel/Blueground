"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apartmentDisplayParts,
  apartmentIdFromUnit,
  apartmentLabel,
} from "@/lib/apartments";
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
  price: number | null;
  available: number | null;
  minNights: number;
  closed: boolean;
  booked: boolean;
  weekend: boolean;
  source: "derived" | "manual" | "minihotel";
  minPrice: number | null;
  maxPrice: number | null;
  note: string | null;
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

const HORIZONS = [30, 60, 90];
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

// Rows render as "<apartment ID> · <address>" and sort by that ID. The ID is
// read from the unit's internal sync name (falling back to the seed id); units
// whose ID can't be determined show their plain name, unnumbered, at the end.
const apptOrd = (unit: { id: string; name: string }): number =>
  apartmentIdFromUnit(unit) ?? Number.POSITIVE_INFINITY;

export function RateCalendar() {
  const [from, setFrom] = useState(todayUTC());
  const [days, setDays] = useState(30);
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
    () =>
      (data?.rows ?? [])
        .filter((r) => hood === "all" || r.unit.neighborhood === hood)
        .sort((a, b) => {
          const d = apptOrd(a.unit) - apptOrd(b.unit);
          return d !== 0 ? d : a.unit.name.localeCompare(b.unit.name);
        }),
    [data, hood],
  );

  const selCell = useMemo(() => {
    if (!sel || !data) return null;
    const row = data.rows.find((r) => r.unit.id === sel.unitId);
    const cell = row?.cells.find((c) => c.date === sel.date);
    return row && cell ? { unit: row.unit, cell } : null;
  }, [sel, data]);

  // Apply a Date Specific Override (range shape). Throws on failure so the
  // panel can show the error inline; the caller closes the panel on success.
  async function applyOverride(body: Record<string, unknown>): Promise<number> {
    setBusy(true);
    try {
      const res = await fetch("/api/rates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; nights?: number };
      if (!res.ok) throw new Error(d.error || `request failed (${res.status})`);
      await refresh();
      return d.nights ?? 0;
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
        errors?: string[];
        message?: string;
      };
      if (d.ok) {
        const extra = d.unmappedTypes && d.unmappedTypes.length ? ` · unmapped: ${d.unmappedTypes.join(", ")}` : "";
        const issues =
          d.errors && d.errors.length
            ? ` · ${d.errors.length} MiniHotel issue(s) skipped: ${d.errors.slice(0, 2).join(" | ")}${d.errors.length > 2 ? " …" : ""}`
            : "";
        setSyncMsg({
          ok: !(d.errors && d.errors.length),
          text: `Synced ${d.written ?? 0} nights across ${d.mappedTypes ?? 0} room type(s)${extra}${issues}.`,
        });
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

      {/* Date Specific Overrides panel */}
      {selCell && (
        <OverridePanel
          key={`${selCell.unit.id}|${selCell.cell.date}`}
          unitId={selCell.unit.id}
          unitName={apartmentLabel(selCell.unit)}
          cell={selCell.cell}
          defaultMinNights={data.defaultMinNights}
          busy={busy}
          onClose={() => setSel(null)}
          onApply={applyOverride}
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
            Click any night to open Date Specific Overrides — set a fixed or percent price, min/max
            bounds, minimum stay, or close a whole date range. Edits are staged locally — wiring the
            push to MiniHotel (Reverse ARI) is the next step.
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
                      <div className="font-medium text-foreground leading-tight">
                        {(() => {
                          const { num, text } = apartmentDisplayParts(row.unit);
                          return (
                            <>
                              {num != null && (
                                <span className="mr-1.5 text-muted-foreground tabular-nums">{num}</span>
                              )}
                              {text}
                            </>
                          );
                        })()}
                      </div>
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
                            title={`${apartmentLabel(row.unit)} · ${c.date}${c.closed ? " · closed" : c.booked ? " · booked" : ""} · min ${c.minNights}n${
                              c.source !== "derived" ? ` · ${c.source}` : ""
                            }`}
                          >
                            <div className="font-medium">
                              {c.closed ? <Lock className="mx-auto h-3 w-3" /> : (c.price ?? "—")}
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
            Empty cells (—) have no MiniHotel data yet — run &ldquo;Sync MiniHotel&rdquo; to fill real
            prices &amp; availability. A dot marks an override:{" "}
            <span className="text-primary">●</span> manual edit ·{" "}
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
  if (c.price == null) return "bg-muted/20 text-muted-foreground/50"; // no data yet (not synced)
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

const sectionCls = "rounded-md bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground";
const fieldLabelCls = "flex flex-col gap-1 text-[11px] text-muted-foreground";

function OverridePanel({
  unitId,
  unitName,
  cell,
  defaultMinNights,
  busy,
  onApply,
  onClose,
}: {
  unitId: string;
  unitName: string;
  cell: RateCell;
  defaultMinNights: number;
  busy: boolean;
  onApply: (body: Record<string, unknown>) => Promise<number>;
  onClose: () => void;
}) {
  const [start, setStart] = useState(cell.date);
  const [end, setEnd] = useState(cell.date);
  const [dowOn, setDowOn] = useState(false);
  const [dow, setDow] = useState<boolean[]>(Array(7).fill(true));
  const [priceMode, setPriceMode] = useState<"fixed" | "pct">("fixed");
  const [priceVal, setPriceVal] = useState("");
  const [minPriceVal, setMinPriceVal] = useState(cell.minPrice == null ? "" : String(cell.minPrice));
  const [maxPriceVal, setMaxPriceVal] = useState(cell.maxPrice == null ? "" : String(cell.maxPrice));
  const [minNightsVal, setMinNightsVal] = useState("");
  const [avail, setAvail] = useState<"" | "close" | "open">("");
  const [note, setNote] = useState(cell.note ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const nights = useMemo(() => {
    const a = Date.parse(start + "T00:00:00Z");
    const b = Date.parse(end + "T00:00:00Z");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    let n = 0;
    for (let t = a; t <= b; t += 86400000) {
      if (!dowOn || dow[new Date(t).getUTCDay()]) n++;
    }
    return n;
  }, [start, end, dowOn, dow]);

  const pct = priceMode === "pct" ? parseFloat(priceVal) : NaN;
  const previewPrice =
    priceVal.trim() === ""
      ? null
      : priceMode === "fixed"
        ? Math.max(0, Math.round(parseFloat(priceVal) || 0))
        : cell.price != null && Number.isFinite(pct)
          ? Math.max(0, Math.round(cell.price * (1 + pct / 100)))
          : null;

  function buildBody(clear: boolean): Record<string, unknown> | string {
    if (nights === 0) return "Pick a valid date range.";
    const body: Record<string, unknown> = { unitId, from: start, to: end };
    if (dowOn) {
      const sel = dow.flatMap((on, i) => (on ? [i] : []));
      if (sel.length === 0) return "Select at least one day of the week.";
      if (sel.length < 7) body.daysOfWeek = sel;
    }
    if (clear) {
      body.clear = true;
      return body;
    }
    if (priceVal.trim() !== "") {
      const n = parseFloat(priceVal);
      if (!Number.isFinite(n)) return "Price must be a number.";
      if (priceMode === "fixed") body.price = Math.max(0, Math.round(n));
      else {
        if (n < -90 || n > 500) return "Percent must be between -90 and 500.";
        body.pricePct = n;
      }
    }
    const intOf = (s: string) => Math.max(0, Math.round(parseFloat(s)));
    if (minPriceVal.trim() !== "") body.minPrice = intOf(minPriceVal);
    if (maxPriceVal.trim() !== "") body.maxPrice = intOf(maxPriceVal);
    if (
      typeof body.minPrice === "number" &&
      typeof body.maxPrice === "number" &&
      body.minPrice > body.maxPrice
    )
      return "Minimum price must be ≤ maximum price.";
    if (minNightsVal.trim() !== "") body.minNights = Math.max(1, Math.round(parseFloat(minNightsVal)));
    if (avail !== "") body.closed = avail === "close";
    if (note.trim() !== (cell.note ?? "")) body.note = note.trim() === "" ? null : note.trim();
    const hasAny = Object.keys(body).some(
      (k) => !["unitId", "from", "to", "daysOfWeek"].includes(k),
    );
    if (!hasAny) return "Set at least one override field.";
    return body;
  }

  async function submit(clear: boolean) {
    setErr(null);
    setOkMsg(null);
    const body = buildBody(clear);
    if (typeof body === "string") {
      setErr(body);
      return;
    }
    try {
      const n = await onApply(body);
      if (clear) {
        setOkMsg(`Removed overrides on ${n} night(s).`);
      } else {
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed");
    }
  }

  const dowChip = (on: boolean) =>
    `h-7 w-9 rounded-md border text-[11px] font-medium transition-colors ${
      on
        ? "border-primary/40 bg-primary/15 text-primary"
        : "border-border bg-card text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Date Specific Overrides</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {unitName}
              <span className="mx-1.5">·</span>clicked {cell.date}
              {cell.booked && (
                <Badge variant="success" className="ml-1.5">
                  booked
                </Badge>
              )}
            </p>
          </div>
          <button type="button" className={iconBtn} title="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* dates */}
          <div className="flex flex-wrap items-end gap-3">
            <label className={fieldLabelCls}>
              From
              <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value || cell.date)} />
            </label>
            <label className={fieldLabelCls}>
              To
              <input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value || cell.date)} />
            </label>
            <label className="flex items-center gap-2 pb-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                checked={dowOn}
                onChange={(e) => setDowOn(e.target.checked)}
              />
              Apply on specific days of the week
            </label>
          </div>
          {dowOn && (
            <div className="flex gap-1.5">
              {WD.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  className={dowChip(dow[i])}
                  onClick={() => setDow((p) => p.map((v, j) => (j === i ? !v : v)))}
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          {/* price settings */}
          <div className={sectionCls}>Price Settings</div>
          <div className="space-y-3">
            <div className="text-[11px] text-muted-foreground">New Final Price</div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-foreground">
                <input
                  type="radio"
                  name="price-mode"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={priceMode === "fixed"}
                  onChange={() => setPriceMode("fixed")}
                />
                Fixed
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground">
                <input
                  type="radio"
                  name="price-mode"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={priceMode === "pct"}
                  onChange={() => setPriceMode("pct")}
                />
                Percent
              </label>
              <div className="relative">
                <input
                  className={`${inputCls} w-32 pr-9`}
                  value={priceVal}
                  onChange={(e) => setPriceVal(e.target.value)}
                  inputMode="decimal"
                  placeholder={priceMode === "fixed" ? (cell.price != null ? String(cell.price) : "—") : "e.g. -10"}
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[10px] text-muted-foreground">
                  {priceMode === "fixed" ? "ILS" : "%"}
                </span>
              </div>
            </div>
            {priceMode === "pct" && (
              <p className="text-[10px] text-muted-foreground">
                Percent adjusts each night&rsquo;s current calendar price (e.g. -10 lowers every night in the
                range by 10%).
              </p>
            )}
            <div className="flex gap-3">
              <label className={fieldLabelCls}>
                Minimum Price
                <input
                  className={`${inputCls} w-28`}
                  value={minPriceVal}
                  onChange={(e) => setMinPriceVal(e.target.value)}
                  inputMode="numeric"
                  placeholder="none"
                />
              </label>
              <label className={fieldLabelCls}>
                Maximum Price
                <input
                  className={`${inputCls} w-28`}
                  value={maxPriceVal}
                  onChange={(e) => setMaxPriceVal(e.target.value)}
                  inputMode="numeric"
                  placeholder="none"
                />
              </label>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Min/max clamp the calendar&rsquo;s own nightly price on those dates; a Fixed final price wins over
              both.
            </p>
          </div>

          {/* stay restrictions */}
          <div className={sectionCls}>Stay Restrictions</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className={fieldLabelCls}>
              Minimum Stay
              <input
                className={`${inputCls} w-28`}
                value={minNightsVal}
                onChange={(e) => setMinNightsVal(e.target.value)}
                inputMode="numeric"
                placeholder={`${cell.minNights}${cell.minNights === defaultMinNights ? " (default)" : ""}`}
              />
            </label>
            <label className={fieldLabelCls}>
              Availability
              <select className={inputCls} value={avail} onChange={(e) => setAvail(e.target.value as "" | "close" | "open")}>
                <option value="">No change</option>
                <option value="close">Close these nights</option>
                <option value="open">Open these nights</option>
              </select>
            </label>
          </div>

          {/* more options */}
          <div className={sectionCls}>More Options</div>
          <label className={fieldLabelCls}>
            Note or Reason for Override
            <input
              className={inputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. holiday weekend, owner request"
              maxLength={500}
            />
          </label>

          {err && <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>}
          {okMsg && <p className="text-[11px] text-[hsl(var(--success))]">{okMsg}</p>}
        </div>

        {/* footer */}
        <div className="border-t border-border px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-muted-foreground">
              <div>
                {nights} night{nights === 1 ? "" : "s"} selected
              </div>
              <div>
                Current: {cell.price != null ? fmtILS(cell.price) : "—"}
                {previewPrice != null && (
                  <>
                    <span className="mx-1">→</span>
                    <span className="font-medium text-foreground">{fmtILS(previewPrice)}</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={btnGhost}
                disabled={busy}
                title="Remove existing overrides on the selected nights"
                onClick={() => submit(true)}
              >
                Clear
              </button>
              <button type="button" className={btnGhost} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={btnCls} disabled={busy} onClick={() => submit(false)}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Add
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
