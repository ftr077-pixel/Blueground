"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apartmentDisplayParts,
  apartmentIdFromUnit,
  apartmentLabel,
} from "@/lib/apartments";
import {
  Banknote,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  DownloadCloud,
  Loader2,
  Lock,
  Percent,
  RefreshCw,
  Save,
  Stethoscope,
  TrendingUp,
  UploadCloud,
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
  pctAdjust: number | null;
  expiresOn: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  note: string | null;
}
interface RankInfo {
  rank: number | null;
  total: number | null;
  page: number | null;
  ts: string;
  nights: number;
  found: boolean;
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
    minRate: number;
    group: string | null;
    subgroup: string | null;
  };
  cells: RateCell[];
  occ30: number | null;
  occ60: number | null;
  occ90: number | null;
  airbnbRank: RankInfo | null;
  monthlyEstimate: { from: string; total: number; nightly: number } | null;
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

// Result of a Reverse-ARI push, as returned by /api/rates.
type PushInfo = { ok: boolean; pushed?: number; warnings?: string[]; errors?: string[]; message?: string };
function pushStatusMsg(p: PushInfo): { ok: boolean; text: string } {
  if (p.ok) {
    const w = p.warnings && p.warnings.length ? ` (warnings: ${p.warnings.slice(0, 2).join("; ")})` : "";
    return { ok: true, text: `Pushed ${p.pushed ?? 0} night(s) to MiniHotel${w}.` };
  }
  const reason = p.message || (p.errors && p.errors.length ? p.errors.slice(0, 2).join(" | ") : "unknown error");
  return { ok: false, text: `Saved locally, but NOT pushed to MiniHotel: ${reason}` };
}

// Hotel-local (Asia/Jerusalem) today — the calendar tracks Tel Aviv nights, and
// UTC would show yesterday as "today" for the first 2-3 hours of each local day.
const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

// ---- day/month/year date field --------------------------------------------
// Native <input type="date"> renders in the BROWSER's locale (US browsers show
// mm/dd/yyyy), which reads wrong here. This field always displays dd/mm/yyyy;
// the calendar button still opens the native picker. Value in/out stays ISO.
const isoToDmy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};
const dmyToIso = (text: string): string | null => {
  const m = /^\s*(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{4}|\d{2})\s*$/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]) + (m[3].length === 2 ? 2000 : 0);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

function DmyDateInput({
  value,
  onChange,
  allowEmpty = false,
  width = "w-32",
}: {
  value: string; // ISO or ""
  onChange: (iso: string) => void;
  allowEmpty?: boolean;
  width?: string;
}) {
  const [text, setText] = useState(isoToDmy(value));
  const pickerRef = useRef<HTMLInputElement>(null);
  useEffect(() => setText(isoToDmy(value)), [value]);

  const commit = () => {
    if (allowEmpty && text.trim() === "") {
      onChange("");
      return;
    }
    const iso = dmyToIso(text);
    if (iso) onChange(iso);
    else setText(isoToDmy(value)); // unparseable — revert to the last good value
  };

  return (
    <span className={`relative inline-flex items-center ${width}`}>
      <input
        className={`${inputCls} w-full pr-7`}
        value={text}
        placeholder="dd/mm/yyyy"
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        title="Open calendar"
        className="absolute right-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => {
          const el = pickerRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
          if (!el) return;
          try {
            el.showPicker?.();
          } catch {
            el.focus();
          }
        }}
      >
        <CalendarDays className="h-3.5 w-3.5" />
      </button>
      {/* invisible native input that only supplies the picker popup */}
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
          else if (allowEmpty) onChange("");
        }}
        className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
      />
    </span>
  );
}
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

// Sortable listing columns (click a header to sort, click again to reverse).
type SortKey = "listing" | "base" | "monthly" | "occ30" | "occ60" | "occ90" | "rank";

function SortMark({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
  return dir === 1 ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
}

export function RateCalendar() {
  const [from, setFrom] = useState(todayLocal());
  const [days, setDays] = useState(30);
  const [hood, setHood] = useState("all");
  const [data, setData] = useState<Calendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ unitId: string; date: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "listing", dir: 1 });
  const [diagnosing, setDiagnosing] = useState(false);
  const [diag, setDiag] = useState<DiagResult | null>(null);

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

  const toggleSort = (key: SortKey) =>
    setSort((p) => (p.key === key ? { key, dir: (p.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const rows = useMemo(() => {
    // Listing order (apartment ID, unknowns last) is both the default sort and
    // the tiebreak for every other column.
    const byListing = (a: RateRow, b: RateRow) => {
      const an = apptOrd(a.unit);
      const bn = apptOrd(b.unit);
      if (an !== bn) return an < bn ? -1 : 1; // Infinity-safe: unnumbered sink last
      return a.unit.name.localeCompare(b.unit.name);
    };
    const val = (r: RateRow): number | null => {
      switch (sort.key) {
        case "listing": {
          const n = apptOrd(r.unit);
          return Number.isFinite(n) ? n : null; // unnumbered listings always last
        }
        case "base": {
          const b = r.unit.baseRate || r.unit.currentRate;
          return b > 0 ? b : null;
        }
        case "monthly":
          return r.monthlyEstimate?.total ?? null;
        case "occ30":
          return r.occ30;
        case "occ60":
          return r.occ60;
        case "occ90":
          return r.occ90;
        case "rank":
          return r.airbnbRank?.found && r.airbnbRank.rank != null ? r.airbnbRank.rank : null;
      }
    };
    return (data?.rows ?? [])
      .filter((r) => hood === "all" || r.unit.neighborhood === hood)
      .sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (va == null && vb == null) return byListing(a, b);
        if (va == null) return 1; // missing values sink to the bottom either way
        if (vb == null) return -1;
        const d = (va - vb) * sort.dir;
        return d !== 0 ? d : byListing(a, b);
      });
  }, [data, hood, sort]);

  const selCell = useMemo(() => {
    if (!sel || !data) return null;
    const row = data.rows.find((r) => r.unit.id === sel.unitId);
    const cell = row?.cells.find((c) => c.date === sel.date);
    return row && cell ? { unit: row.unit, cell, cells: row.cells } : null;
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
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        nights?: number;
        push?: PushInfo;
      };
      if (!res.ok) throw new Error(d.error || `request failed (${res.status})`);
      // Surface whether the edit actually reached MiniHotel (Reverse ARI).
      setSyncMsg(d.push ? pushStatusMsg(d.push) : null);
      await refresh();
      return d.nights ?? 0;
    } finally {
      setBusy(false);
    }
  }

  async function saveBaseRate(unitId: string, rate: number) {
    setError(null);
    try {
      await applyOverride({ unitId, baseRate: rate });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save base rate");
    }
  }

  // PUSH: send our intended prices (pins win, else derived-from-Base) out to
  // MiniHotel for the selected horizon. The mirror of the Pull button.
  async function pushMiniHotel() {
    setPushing(true);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/rates/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const d = (await r.json()) as {
        ok: boolean;
        repriced?: number;
        pushed?: number;
        units?: number;
        unmappedUnits?: number;
        days?: number;
        errors?: string[];
        message?: string;
      };
      if (d.ok) {
        setSyncMsg({
          ok: true,
          text: `Pushed ${d.pushed ?? 0} night(s) across ${d.units ?? 0} apartment(s) to MiniHotel (${d.days ?? days}-day horizon).${
            d.unmappedUnits ? ` ${d.unmappedUnits} apartment(s) skipped — not mapped to a room type (Settings).` : ""
          }`,
        });
      } else {
        const reason =
          d.message || (d.errors && d.errors.length ? d.errors.slice(0, 2).join(" | ") : "push failed");
        setSyncMsg({ ok: false, text: `Push to MiniHotel failed: ${reason}` });
      }
      await refresh();
    } catch (e) {
      setSyncMsg({ ok: false, text: e instanceof Error ? e.message : "push failed" });
    } finally {
      setPushing(false);
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
        note?: string;
        reservations?: number;
        bookedNights?: number;
        message?: string;
      };
      if (d.ok) {
        const errs = d.errors ?? [];
        const errText = `${errs.slice(0, 2).join(" | ")}${errs.length > 2 ? " …" : ""}`;
        const resTxt =
          d.reservations != null
            ? ` · ${d.bookedNights ?? 0} sold night(s) from ${d.reservations} reservation(s) over the next 12 months`
            : "";
        // Nothing written + an error = MiniHotel's bulk feed aborted on one bad
        // room type (it can't be told to skip rooms). Say so plainly — "skipped"
        // would be a lie, since one bad room blocks every room. If reservations
        // still loaded, occupancy is real even though prices are blocked.
        if ((d.written ?? 0) === 0 && errs.length) {
          setSyncMsg({
            ok: (d.bookedNights ?? 0) > 0,
            text: `MiniHotel returned no rates — its feed was blocked by a room-type config error: ${errText}. One misconfigured room stops EVERY room from syncing. In MiniHotel, set that room type's Basic occupancy (or deactivate the room type), then Sync again.${
              (d.bookedNights ?? 0) > 0 ? ` Occupancy still loaded:${resTxt.replace(" ·", "")}.` : ""
            }`,
          });
        } else {
          const extra = d.unmappedTypes && d.unmappedTypes.length ? ` · unmapped: ${d.unmappedTypes.join(", ")}` : "";
          const issues = errs.length ? ` · ${errs.length} MiniHotel issue(s): ${errText}` : "";
          const via = d.note ? ` ${d.note}` : "";
          setSyncMsg({
            ok: !errs.length || !!d.note,
            text: `Synced ${d.written ?? 0} nights across ${d.mappedTypes ?? 0} room type(s)${resTxt}${extra}${issues}.${via}`,
          });
        }
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

  async function diagnose() {
    setDiagnosing(true);
    setDiag(null);
    try {
      const r = await fetch("/api/rates/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testPush: true }),
      });
      setDiag((await r.json()) as DiagResult);
    } catch (e) {
      setDiag({ ok: false, message: e instanceof Error ? e.message : "diagnose failed" });
    } finally {
      setDiagnosing(false);
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
          value={s.bookedRevenue > 0 ? fmtILS(s.bookedRevenue) : "—"}
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
            <DmyDateInput value={from} onChange={(v) => setFrom(v || todayLocal())} />
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
            <button className={`${inputCls} h-8`} onClick={() => setFrom(todayLocal())}>
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
            title="PULL: import MiniHotel's current prices & availability INTO this calendar (overwrites unsaved staged prices with what the PMS has)"
            disabled={syncing || pushing}
            onClick={syncMiniHotel}
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            Pull from MiniHotel
          </button>
          <button
            className={btnCls}
            title="PUSH: send this calendar's prices OUT to MiniHotel for the selected horizon — manual pins win, otherwise each night derives from the apartment's Base"
            disabled={pushing || syncing}
            onClick={pushMiniHotel}
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
            Push to MiniHotel
          </button>
          <button
            className={btnGhost}
            title="Show exactly what MiniHotel's rate feed returns and why the calendar is empty"
            disabled={diagnosing}
            onClick={diagnose}
          >
            {diagnosing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            Diagnose
          </button>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 w-12 rounded-sm border border-border/50"
                style={{
                  background:
                    "linear-gradient(90deg, hsla(8,70%,48%,0.42), hsla(75,70%,48%,0.10), hsla(142,70%,48%,0.42))",
                }}
              />
              Price vs this unit&rsquo;s typical (low → high)
            </span>
            <LegendSwatch className="bg-muted/60" label="Sold" />
            <LegendSwatch className="bg-danger/10" label="Closed" />
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

      {diag && (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-[11px]">
          <p className="font-medium text-foreground">{diagVerdict(diag)}</p>
          {diag.ok && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>
                rate code: <span className="text-foreground">{diag.rateCode}</span>
              </span>
              <span>
                room types in feed: <span className="text-foreground">{diag.roomTypesInFeed}</span>
              </span>
              <span>
                priced nights: <span className="text-foreground">{diag.pricedCells}</span>
              </span>
              <span>
                matched to apartments: <span className="text-foreground">{diag.mappedToUnits}</span>
              </span>
            </div>
          )}
          {diag.sampleRoomTypeIds && diag.sampleRoomTypeIds.length > 0 && (
            <p className="text-muted-foreground">
              ARI room ids: <span className="font-mono text-foreground">{diag.sampleRoomTypeIds.join(", ")}</span>
            </p>
          )}
          {diag.errors && diag.errors.length > 0 && (
            <p className="text-[hsl(var(--warning))]">errors: {diag.errors.join(" | ")}</p>
          )}
          {diag.guests && (
            <div className="mt-1 border-t border-border/60 pt-1.5">
              <p
                className={
                  diag.guests.roomTypes > 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--warning))]"
                }
              >
                {guestsVerdict(diag.guests)}
              </p>
              {diag.guests.sample.length > 0 && (
                <p className="text-muted-foreground">
                  availability-search room ids:{" "}
                  <span className="font-mono text-foreground">{diag.guests.sample.join(", ")}</span>
                </p>
              )}
            </div>
          )}
          {diag.pushTest && (
            <div className="mt-1 border-t border-border/60 pt-1.5">
              <p
                className={
                  diag.pushTest.applied
                    ? "text-[hsl(var(--success))]"
                    : "text-[hsl(var(--warning))]"
                }
              >
                Push test: {diag.pushTest.message}
              </p>
              {diag.pushTest.attempted && (
                <p className="text-muted-foreground">
                  {diag.pushTest.roomType} · {diag.pushTest.date} · ₪{diag.pushTest.before} → pushed ₪
                  {diag.pushTest.pushedValue} → feed read{" "}
                  {diag.pushTest.readBack != null ? `₪${diag.pushTest.readBack}` : "—"}
                  {diag.pushTest.reverted ? " · reverted" : " · REVERT FAILED — check this night"}
                  {diag.pushTest.requestId ? ` · req ${diag.pushTest.requestId}` : ""}
                </p>
              )}
              {diag.pushTest.pushErrors && diag.pushTest.pushErrors.length > 0 && (
                <p className="text-[hsl(var(--danger))]">{diag.pushTest.pushErrors.join(" | ")}</p>
              )}
            </div>
          )}
          {diag.rawHead && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">raw response</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                {diag.rawHead}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Date Specific Overrides panel */}
      {selCell && (
        <OverridePanel
          key={`${selCell.unit.id}|${selCell.cell.date}`}
          unitId={selCell.unit.id}
          unitName={apartmentLabel(selCell.unit)}
          cell={selCell.cell}
          cells={selCell.cells}
          windowFrom={data.from}
          windowDays={data.days}
          defaultMinNights={data.defaultMinNights}
          groupName={selCell.unit.group ?? selCell.unit.subgroup ?? null}
          groupCount={(() => {
            const g = selCell.unit.group ?? selCell.unit.subgroup;
            if (!g) return 0;
            return data.rows.filter((r) => r.unit.group === g || r.unit.subgroup === g).length;
          })()}
          unitMinRate={selCell.unit.minRate}
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
            bounds, minimum stay, or close a whole date range. Price, min-nights and closures are
            pushed straight to MiniHotel (Reverse ARI) on save; min/max bounds are local guardrails.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="border-collapse text-[11px] tabular-nums">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 w-48 min-w-[12rem] max-w-[12rem] bg-card px-3 py-2 text-left font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      title="Sort by apartment ID"
                      onClick={() => toggleSort("listing")}
                    >
                      Listing
                      <SortMark active={sort.key === "listing"} dir={sort.dir} />
                    </button>
                  </th>
                  <th className="sticky left-[12rem] z-20 w-20 min-w-[5rem] max-w-[5rem] bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 hover:text-foreground"
                      title="Base rate (₪) — the anchor every nightly price builds from. Click to sort."
                      onClick={() => toggleSort("base")}
                    >
                      Base
                      <SortMark active={sort.key === "base"} dir={sort.dir} />
                    </button>
                  </th>
                  <th className="sticky left-[17rem] z-20 w-20 min-w-[5rem] max-w-[5rem] bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex flex-col items-center hover:text-foreground"
                      title="Monthly estimate: from the first date a 30-night stay can start, the sum of those 30 nightly rates minus 20%. Click to sort."
                      onClick={() => toggleSort("monthly")}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Monthly
                        <SortMark active={sort.key === "monthly"} dir={sort.dir} />
                      </span>
                      <span className="text-[9px] font-normal">est. −20%</span>
                    </button>
                  </th>
                  <th className="sticky left-[22rem] z-20 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex flex-col items-center hover:text-foreground"
                      title="Occupancy over the next 30 nights (sold ÷ sellable). Click to sort."
                      onClick={() => toggleSort("occ30")}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Occ
                        <SortMark active={sort.key === "occ30"} dir={sort.dir} />
                      </span>
                      <span className="text-[9px] font-normal">30N</span>
                    </button>
                  </th>
                  <th className="sticky left-[25.5rem] z-20 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex flex-col items-center hover:text-foreground"
                      title="Occupancy over the next 60 nights (sold ÷ sellable). Click to sort."
                      onClick={() => toggleSort("occ60")}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Occ
                        <SortMark active={sort.key === "occ60"} dir={sort.dir} />
                      </span>
                      <span className="text-[9px] font-normal">60N</span>
                    </button>
                  </th>
                  <th className="sticky left-[29rem] z-20 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex flex-col items-center hover:text-foreground"
                      title="Occupancy over the next 90 nights (sold ÷ sellable). Click to sort."
                      onClick={() => toggleSort("occ90")}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Occ
                        <SortMark active={sort.key === "occ90"} dir={sort.dir} />
                      </span>
                      <span className="text-[9px] font-normal">90N</span>
                    </button>
                  </th>
                  <th className="sticky left-[32.5rem] z-20 w-16 min-w-[4rem] max-w-[4rem] border-r border-border bg-card px-1 py-2 text-center font-medium text-muted-foreground">
                    <button
                      type="button"
                      className="inline-flex flex-col items-center hover:text-foreground"
                      title="Latest Airbnb search position for the tracked 1-month stay (visibility tab). Click to sort — best position first."
                      onClick={() => toggleSort("rank")}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Airbnb
                        <SortMark active={sort.key === "rank"} dir={sort.dir} />
                      </span>
                      <span className="text-[9px] font-normal">1mo #</span>
                    </button>
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
                {rows.map((row) => {
                  const typical = typicalRate(row);
                  return (
                  <tr key={row.unit.id} className="border-t border-border/50">
                    <th className="sticky left-0 z-10 w-48 min-w-[12rem] max-w-[12rem] bg-card px-3 py-1.5 text-left align-middle">
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
                      </div>
                    </th>
                    <td className="sticky left-[12rem] z-10 w-20 min-w-[5rem] max-w-[5rem] bg-card px-1 py-1.5 text-center align-middle">
                      <BaseRateCell
                        value={row.unit.baseRate || row.unit.currentRate || 0}
                        busy={busy}
                        onSave={(n) => saveBaseRate(row.unit.id, n)}
                      />
                    </td>
                    <td className="sticky left-[17rem] z-10 w-20 min-w-[5rem] max-w-[5rem] bg-card px-1 py-1.5 text-center align-middle">
                      {row.monthlyEstimate ? (
                        <span
                          className="text-[11px] font-medium tabular-nums text-foreground"
                          title={`30 nights from ${row.monthlyEstimate.from} · ~₪${row.monthlyEstimate.nightly.toLocaleString("en-US")}/night · after −20%`}
                        >
                          {fmtILS(row.monthlyEstimate.total)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="sticky left-[22rem] z-10 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-1.5 text-center align-middle">
                      <OccPill v={row.occ30} />
                    </td>
                    <td className="sticky left-[25.5rem] z-10 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-1.5 text-center align-middle">
                      <OccPill v={row.occ60} />
                    </td>
                    <td className="sticky left-[29rem] z-10 w-14 min-w-[3.5rem] max-w-[3.5rem] bg-card px-1 py-1.5 text-center align-middle">
                      <OccPill v={row.occ90} />
                    </td>
                    <td className="sticky left-[32.5rem] z-10 w-16 min-w-[4rem] max-w-[4rem] border-r border-border bg-card px-1 py-1.5 text-center align-middle">
                      <RankCell rk={row.airbnbRank} />
                    </td>
                    {row.cells.map((c) => {
                      const selected = sel?.unitId === row.unit.id && sel?.date === c.date;
                      const monthStart = partsUTC(c.date).day === 1;
                      const tone =
                        !c.closed && !c.booked && c.price != null && typical
                          ? priceTone(c.price, typical)
                          : null;
                      return (
                        <td key={c.date} className={`p-0 ${monthStart ? "border-l border-border" : ""}`}>
                          <button
                            type="button"
                            onClick={() => setSel({ unitId: row.unit.id, date: c.date })}
                            className={`relative h-11 w-14 px-1 leading-tight transition-colors ${tone ? "text-foreground" : cellTone(c)} ${
                              selected ? "ring-2 ring-primary ring-inset" : "hover:brightness-95"
                            }`}
                            style={tone ? { backgroundColor: tone } : undefined}
                            title={`${apartmentLabel(row.unit)} · ${c.date}${c.closed ? " · closed" : c.booked ? " · booked" : ""} · min ${c.minNights}n${
                              c.source !== "derived" ? ` · ${c.source}` : ""
                            }${tone && typical ? ` · ${Math.round(((c.price as number) / typical) * 100)}% of typical ₪${typical}` : ""}`}
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
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Empty cells (—) have no MiniHotel data yet — run &ldquo;Pull from MiniHotel&rdquo; to fill real
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
  if (c.booked) return "bg-muted/60 text-muted-foreground"; // sold = gray
  if (c.price == null) return "bg-muted/20 text-muted-foreground/50"; // no data yet (not synced)
  if (c.weekend) return "bg-muted/50 text-foreground";
  return "bg-card text-foreground";
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Typical nightly rate for a unit: its configured rate, else the median of
 *  the prices visible in the window (covers synced units with rate 0). */
function typicalRate(row: RateRow): number | null {
  if (row.unit.currentRate > 0) return row.unit.currentRate;
  if (row.unit.baseRate > 0) return row.unit.baseRate;
  const ps = row.cells
    .filter((c) => !c.booked && !c.closed && c.price != null)
    .map((c) => c.price as number)
    .sort((a, b) => a - b);
  return ps.length ? ps[Math.floor(ps.length / 2)] : null;
}

/**
 * Translucent wash for an open night's price RELATIVE TO THIS UNIT's typical
 * rate: ≤70% of typical → red/orange · 100% → barely-there neutral · ≥135% →
 * green. Low alpha keeps the whole calendar calm to scan, and because it's a
 * tint over the theme background, the normal foreground text stays readable
 * in both light and dark mode.
 */
function priceTone(price: number, typical: number): string {
  const ratio = price / typical;
  const t =
    ratio <= 1
      ? 0.5 * clamp01((ratio - 0.7) / 0.3) // 0.70→0 (red/orange) … 1.00→0.5
      : 0.5 + 0.5 * clamp01((ratio - 1) / 0.35); // 1.00→0.5 … 1.35→1 (green)
  const hue = 8 + t * (142 - 8); // red/orange → green
  const intensity = Math.abs(t - 0.5) * 2; // 0 at typical price, 1 at extremes
  const alpha = 0.1 + intensity * 0.32; // gentle wash, a bit deeper at extremes
  return `hsla(${hue.toFixed(0)}, 70%, 48%, ${alpha.toFixed(2)})`;
}

interface DiagResult {
  ok: boolean;
  message?: string;
  rateCode?: string;
  roomTypesInFeed?: number;
  sampleRoomTypeIds?: string[];
  pricedCells?: number;
  mappedToUnits?: number;
  unmatchedRoomTypes?: string[];
  errors?: string[];
  guests?: { roomTypes: number; priced: number; sample: string[]; errors: string[] };
  pushTest?: {
    attempted: boolean;
    message: string;
    roomType?: string;
    date?: string;
    before?: number;
    pushedValue?: number;
    requestId?: string;
    pushErrors?: string[];
    readBack?: number | null;
    applied?: boolean;
    reverted?: boolean;
  };
  rawHead?: string;
}

function diagVerdict(d: DiagResult): string {
  if (!d.ok) return d.message || "Diagnose failed.";
  const rt = d.roomTypesInFeed ?? 0;
  const mapped = d.mappedToUnits ?? 0;
  const priced = d.pricedCells ?? 0;
  if (rt === 0) {
    const e309 = (d.errors || []).find((x) => /ERR\s?309/i.test(x));
    if (e309 || d.rateCode === "*ALL" || d.rateCode === "(none)")
      return `MiniHotel returned no room types — the rate code "${d.rateCode}" isn't a valid price list. Set a real one via Settings → Find rate code.`;
    if (d.errors && d.errors.length) return `MiniHotel returned no room types. It said: ${d.errors.join(" | ")}`;
    return "MiniHotel returned an empty ARI response (no room types, no error).";
  }
  if (mapped === 0)
    return `ARI returned ${rt} room type(s), but NONE match your apartment mapping — so nothing can fill in. Update the apartment codes to match the ARI ids below.`;
  if (priced === 0)
    return `Matched ${mapped} room type(s), but no prices came back${d.errors && d.errors.length ? ` (${d.errors.join("; ")})` : ""} — likely occupancy isn't set on those rooms.`;
  return `Looks good: ${priced} priced night(s) across ${mapped} matched room type(s). Hit "Pull from MiniHotel" to load them.`;
}

// Verdict for the guests-based fallback probe (only run when the bulk feed is empty).
function guestsVerdict(g: NonNullable<DiagResult["guests"]>): string {
  if (g.roomTypes > 0)
    return `Fallback works: the availability search returned ${g.roomTypes} room type(s)${g.priced ? `, ${g.priced} priced` : ""} despite the bulk feed being blocked — Sync will use it automatically.`;
  const e310 = (g.errors || []).find((x) => /ERR\s?310/i.test(x));
  if (e310)
    return `Fallback can't help either — the availability search hit the same config error (${e310}). This must be fixed in MiniHotel: set the room type's Basic occupancy (or deactivate it).`;
  return `Fallback returned no rooms${g.errors && g.errors.length ? ` (${g.errors.join("; ")})` : ""} — the broken room must be fixed in MiniHotel.`;
}

/** PriceLabs-style editable Base: the anchor every nightly price builds from. */
function BaseRateCell({ value, busy, onSave }: { value: number; busy: boolean; onSave: (n: number) => void }) {
  const [v, setV] = useState(value ? String(value) : "");
  useEffect(() => setV(value ? String(value) : ""), [value]);
  const commit = () => {
    const n = Math.round(parseFloat(v));
    if (!Number.isFinite(n) || n <= 0 || n === value) {
      setV(value ? String(value) : "");
      return;
    }
    onSave(n);
  };
  return (
    <input
      className={`${inputCls} w-[4.25rem] px-1.5 text-right tabular-nums`}
      value={v}
      disabled={busy}
      inputMode="numeric"
      placeholder="—"
      title="Base rate (₪) — press Enter to save; derived prices rebuild from it"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function OccPill({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const pct = Math.round(v * 100);
  const cls =
    pct < 35
      ? "bg-danger/10 text-[hsl(var(--danger))]"
      : pct < 70
        ? "bg-warning/10 text-[hsl(var(--warning))]"
        : "bg-muted/40 text-muted-foreground";
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${cls}`}>
      {pct}%
    </span>
  );
}

function RankCell({ rk }: { rk: RankInfo | null }) {
  if (!rk) return <span className="text-muted-foreground/50">—</span>;
  if (!rk.found || rk.rank == null)
    return (
      <span
        className="text-[10px] text-muted-foreground"
        title={`Not found in the latest 1-month-stay scan (${rk.ts.slice(0, 10)})`}
      >
        n/f
      </span>
    );
  return (
    <span
      className="inline-block rounded-full bg-info/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[hsl(var(--info))]"
      title={`Airbnb position ${rk.rank}${rk.total ? ` of ${rk.total}` : ""}${rk.page ? ` · page ${rk.page}` : ""} · ${rk.nights}-night stay · scanned ${rk.ts.slice(0, 10)}`}
    >
      #{rk.rank}
    </span>
  );
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
  cells,
  windowFrom,
  windowDays,
  defaultMinNights,
  groupName,
  groupCount,
  unitMinRate,
  busy,
  onApply,
  onClose,
}: {
  unitId: string;
  unitName: string;
  cell: RateCell;
  /** The unit's cells for the currently loaded window (for range totals). */
  cells: RateCell[];
  windowFrom: string;
  windowDays: number;
  defaultMinNights: number;
  /** The unit's customization group (group ?? subgroup) for group-level DSOs. */
  groupName: string | null;
  groupCount: number;
  /** The listing's minimum price — fixed overrides below it get a warning. */
  unitMinRate: number;
  busy: boolean;
  onApply: (body: Record<string, unknown>) => Promise<number>;
  onClose: () => void;
}) {
  const [start, setStart] = useState(cell.date);
  const [end, setEnd] = useState(cell.date);
  const [dowOn, setDowOn] = useState(false);
  const [dow, setDow] = useState<boolean[]>(Array(7).fill(true));
  const [priceMode, setPriceMode] = useState<"fixed" | "pct" | "pctDyn">(
    cell.pctAdjust != null ? "pctDyn" : "fixed",
  );
  const [priceVal, setPriceVal] = useState(cell.pctAdjust != null ? String(cell.pctAdjust) : "");
  const [expiry, setExpiry] = useState(cell.expiresOn ?? "");
  const [copyFrom, setCopyFrom] = useState("");
  const [copyTo, setCopyTo] = useState("");
  const [minPriceVal, setMinPriceVal] = useState(cell.minPrice == null ? "" : String(cell.minPrice));
  const [maxPriceVal, setMaxPriceVal] = useState(cell.maxPrice == null ? "" : String(cell.maxPrice));
  const [minNightsVal, setMinNightsVal] = useState("");
  const [avail, setAvail] = useState<"" | "close" | "open">("");
  const [note, setNote] = useState(cell.note ?? "");
  const [applyGroup, setApplyGroup] = useState(false);
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

  // Nightly prices for the selected range. Inside the loaded window we use the
  // cells we already have; a range reaching beyond it is fetched (debounced,
  // capped at the API's 120-day window) so the totals stay correct.
  const [rangeCells, setRangeCells] = useState<{ date: string; price: number | null }[] | null>(
    cells.length ? cells : null,
  );
  const [quoteLoading, setQuoteLoading] = useState(false);
  useEffect(() => {
    const a = Date.parse(start + "T00:00:00Z");
    const b = Date.parse(end + "T00:00:00Z");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) {
      setRangeCells(null);
      return;
    }
    const winA = Date.parse(windowFrom + "T00:00:00Z");
    const winB = winA + (windowDays - 1) * 86400000;
    if (a >= winA && b <= winB) {
      setRangeCells(cells);
      return;
    }
    setQuoteLoading(true);
    const span = Math.min(120, Math.round((b - a) / 86400000) + 1);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/rates?from=${start}&days=${span}`, { cache: "no-store" });
        const j = (await r.json()) as { rows?: { unit: { id: string }; cells: RateCell[] }[] };
        const row = j.rows?.find((x) => x.unit.id === unitId);
        setRangeCells(row ? row.cells : null);
      } catch {
        setRangeCells(null);
      } finally {
        setQuoteLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      setQuoteLoading(false);
    };
  }, [start, end, windowFrom, windowDays, cells, unitId]);

  const pct = priceMode !== "fixed" ? parseFloat(priceVal) : NaN;
  const fixedPrice =
    priceMode === "fixed" && priceVal.trim() !== "" ? Math.max(0, Math.round(parseFloat(priceVal) || 0)) : null;

  // Stay quote over the selected nights: current sum/avg and — once a fixed or
  // percent price is entered — the new sum/avg. "The final output price."
  const quote = useMemo(() => {
    if (nights === 0 || !rangeCells) return null;
    const inRange = rangeCells.filter(
      (c) => c.date >= start && c.date <= end && (!dowOn || dow[new Date(c.date + "T00:00:00Z").getUTCDay()]),
    );
    const priced = inRange.filter((c) => c.price != null) as { date: string; price: number }[];
    const covered = inRange.length; // nights we have data for (may be < nights if capped)
    const curTotal = priced.reduce((s, c) => s + c.price, 0);
    let newTotal: number | null = null;
    if (fixedPrice != null) {
      newTotal = fixedPrice * covered; // a fixed price applies to every selected night
    } else if (priceMode !== "fixed" && priceVal.trim() !== "" && Number.isFinite(pct)) {
      newTotal = priced.reduce((s, c) => s + Math.max(0, Math.round(c.price * (1 + pct / 100))), 0);
    }
    return {
      covered,
      pricedCount: priced.length,
      curTotal,
      curAvg: priced.length ? curTotal / priced.length : null,
      newTotal,
      newAvg:
        newTotal == null
          ? null
          : fixedPrice != null
            ? covered
              ? newTotal / covered
              : null
            : priced.length
              ? newTotal / priced.length
              : null,
      capped: covered < nights,
    };
  }, [nights, rangeCells, start, end, dowOn, dow, fixedPrice, priceMode, priceVal, pct]);

  function buildBody(clear: boolean): Record<string, unknown> | string {
    if (nights === 0) return "Pick a valid date range.";
    const body: Record<string, unknown> = { unitId, from: start, to: end };
    if (applyGroup && groupName) body.applyToGroup = true;
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
        // "% of recommended" stays dynamic (reapplied to the derived rate each
        // read, honors per-date min/max); "% of base" materializes a fixed price.
        body.pricePctMode = priceMode === "pctDyn" ? "dynamic" : "fixed";
      }
    }
    if (expiry.trim() !== (cell.expiresOn ?? "")) {
      body.expiresOn = expiry.trim() === "" ? null : expiry.trim();
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
      // "Copy to another date range": fire the same override at the copy range.
      if (!clear && copyFrom && copyTo) {
        await onApply({ ...body, from: copyFrom, to: copyTo });
      }
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
              <DmyDateInput value={start} onChange={(v) => setStart(v || cell.date)} />
            </label>
            <label className={fieldLabelCls}>
              To
              <DmyDateInput value={end} onChange={(v) => setEnd(v || cell.date)} />
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
                % of base
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground">
                <input
                  type="radio"
                  name="price-mode"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={priceMode === "pctDyn"}
                  onChange={() => setPriceMode("pctDyn")}
                />
                % of recommended
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
                Materialized once off each night&rsquo;s current price — the result is a STATIC
                price (no further dynamic adjustments), like PriceLabs&rsquo; &ldquo;% of base&rdquo;.
              </p>
            )}
            {priceMode === "pctDyn" && (
              <p className="text-[10px] text-muted-foreground">
                Stored as a % and reapplied to the recommended rate on every read — stays DYNAMIC
                and honors the per-date min/max, like PriceLabs&rsquo; &ldquo;% of recommended price&rdquo;.
              </p>
            )}
            {priceMode === "fixed" && fixedPrice != null && fixedPrice < unitMinRate && (
              <p className="text-[10px] font-medium text-amber-600">
                ⚠ ₪{fixedPrice} is below this listing&rsquo;s minimum price (₪{unitMinRate}). A fixed
                override bypasses the min/max — double-check before applying.
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
          <div className="flex flex-wrap gap-3">
            <label className={fieldLabelCls}>
              Override expiry (auto-disable after)
              <DmyDateInput allowEmpty width="w-40" value={expiry} onChange={setExpiry} />
            </label>
            <label className={fieldLabelCls}>
              Copy to another range — from
              <DmyDateInput allowEmpty width="w-40" value={copyFrom} onChange={setCopyFrom} />
            </label>
            <label className={fieldLabelCls}>
              to
              <DmyDateInput allowEmpty width="w-40" value={copyTo} onChange={setCopyTo} />
            </label>
          </div>
          {(cell.createdAt || cell.updatedAt) && (
            <p className="text-[10px] text-muted-foreground/70">
              Override on {cell.date}: created {cell.createdAt?.slice(0, 10) ?? "—"} · updated{" "}
              {cell.updatedAt?.slice(0, 10) ?? "—"}
              {cell.expiresOn ? ` · expires ${cell.expiresOn}` : ""}
              {cell.pctAdjust != null ? ` · dynamic ${cell.pctAdjust > 0 ? "+" : ""}${cell.pctAdjust}% of recommended` : ""}
            </p>
          )}

          {err && <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>}
          {okMsg && <p className="text-[11px] text-[hsl(var(--success))]">{okMsg}</p>}
        </div>

        {/* footer */}
        <div className="border-t border-border px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-muted-foreground">
              <div>
                {nights} night{nights === 1 ? "" : "s"} selected
                {quote && quote.pricedCount < quote.covered && (
                  <span> · {quote.covered - quote.pricedCount} without data</span>
                )}
                {quote?.capped && <span> · totals cover first {quote.covered}</span>}
              </div>
              {quoteLoading ? (
                <div>Calculating totals…</div>
              ) : quote && (quote.pricedCount > 0 || quote.newTotal != null) ? (
                <>
                  <div>
                    Current:{" "}
                    {quote.pricedCount > 0 ? (
                      <>
                        {fmtILS(quote.curAvg ?? 0)}/night ·{" "}
                        <span className="font-medium text-foreground">{fmtILS(quote.curTotal)} total</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  {quote.newTotal != null && (
                    <div>
                      New: {quote.newAvg != null ? `${fmtILS(quote.newAvg)}/night · ` : ""}
                      <span className="font-semibold text-foreground">{fmtILS(quote.newTotal)} total</span>
                    </div>
                  )}
                </>
              ) : (
                <div>Current: — (no priced nights in range)</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {groupName && (
                <label className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={applyGroup}
                    onChange={(e) => setApplyGroup(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  />
                  Apply to all {groupCount} listings in “{groupName}”
                </label>
              )}
              <button
                type="button"
                className={btnGhost}
                disabled={busy}
                title="Remove existing overrides on the selected nights — the baseline price and default min-stay are re-pushed to MiniHotel in the same action, so the removed restriction can't linger on the PMS"
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
