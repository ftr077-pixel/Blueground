"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PacingPoint {
  date: string;
  booked_rate_avg: number;
  available_rate_avg: number;
  fill_rate: number;
}
interface MinNightsPoint { date: string; p50: number }
interface MetricsPoint {
  date: string;
  occupancy: number;
  average_daily_rate: number;
  revpar: number;
  booking_lead_time: number;
  length_of_stay: number;
  active_listings_count: number;
}
interface Summary {
  occupancy: number;
  average_daily_rate: number;
  rev_par: number;
  revenue: number;
  booking_lead_time: number;
  length_of_stay: number;
  min_nights: number;
  active_listings_count: number;
}
interface Snapshot {
  neighborhood: string;
  marketName: string | null;
  fetchedAt: string;
  currency: string | null;
  summary: Summary | null;
  pacing: PacingPoint[];
  minNights: MinNightsPoint[];
  metrics: MetricsPoint[];
  filterLabel: string | null;
  extras: {
    bookingCurves?: { month: string; points: { w: number; o: number; ly: number }[] }[];
    los?: { bucket: string; count: number; share: number; bnp: number }[];
    summaryTable?: {
      kind: string;
      rows: { category: string; occupancy: number; adr: number; revpar: number; los: number; bookingWindow: number }[];
    };
  } | null;
}
interface OurSeries {
  monthly: { month: string; occupancy: number; adr: number; revpar: number }[];
  forwardOcc: { date: string; occupancy: number }[];
  forwardRate: { date: string; rate: number }[];
  los: { bucket: string; share: number }[];
  byBedroom: { label: string; count: number; adr: number; occupancy: number }[];
  pickup: { month: string; points: { w: number; occ: number }[] }[];
  hasData: boolean;
}
interface MarketResp {
  source: string;
  configured: boolean;
  bedrooms: string;
  snapshots: Snapshot[];
  ours?: OurSeries;
}
interface SyncResult {
  ok: boolean;
  reason?: string;
  filterLabel: string | null;
  synced: { neighborhood: string; market: string; pacingPoints: number; metricsMonths: number }[];
  failed: { neighborhood: string; error: string }[];
}

const BEDROOM_OPTS = [
  { v: "", l: "All units" },
  { v: "0", l: "Studio" },
  { v: "1", l: "1 BR" },
  { v: "2", l: "2 BR" },
  { v: "3", l: "3 BR" },
  { v: "4", l: "4+ BR" },
];

// Plain YYYY-MM-DD strings are split, not parsed via Date(): new Date("…")
// is UTC midnight, and local getters west of UTC would shift every label a
// day (and the month series a month). Same approach as analytics-panel.
const shortDate = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return m && d ? `${m}/${d}` : iso;
};
const monthLabel = (iso: string) => {
  const [y, m] = iso.slice(0, 10).split("-").map(Number);
  return y && m ? `${m}/${String(y).slice(2)}` : iso;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// "February 2026" (PriceLabs booking-curve label) → "2026-02" (our pickup key).
const monthKey = (label: string | null) => {
  if (!label) return null;
  const [name, yr] = label.split(" ");
  const i = MONTHS.indexOf(name);
  return i >= 0 && yr ? `${yr}-${String(i + 1).padStart(2, "0")}` : null;
};
const fmtRel = (iso: string) => {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function ChartCard({
  title,
  desc,
  empty,
  children,
}: {
  title: string;
  desc: string;
  empty: boolean;
  children: ReactElement;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-[11px] text-muted-foreground">No data for this metric.</p>
        ) : (
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>{children}</ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const GRID = "hsl(214 32% 91%)";
const AXIS = "hsl(215 16% 47%)";

export function MarketAnalyticsPanel() {
  const [resp, setResp] = useState<MarketResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bedrooms, setBedrooms] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [bcMonth, setBcMonth] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    const r = await fetch("/api/market", { cache: "no-store" });
    if (!r.ok) throw new Error(`load failed: ${r.status}`);
    const b = (await r.json()) as MarketResp;
    setResp(b);
    setBedrooms(b.bedrooms ?? "");
    setSelected((cur) => cur ?? b.snapshots[0]?.neighborhood ?? null);
  }

  useEffect(() => {
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  async function syncNow(bed: string) {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const r = await fetch("/api/market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bedrooms: bed }),
      });
      setSyncResult((await r.json()) as SyncResult);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function onBedrooms(v: string) {
    setBedrooms(v);
    syncNow(v);
  }

  const BedroomSelect = (
    <select
      value={bedrooms}
      onChange={(e) => onBedrooms(e.target.value)}
      disabled={syncing}
      title="Scope the market data to comparable units"
      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs disabled:opacity-50"
    >
      {BEDROOM_OPTS.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
  const SyncBtn = (
    <button
      type="button"
      onClick={() => syncNow(bedrooms)}
      disabled={syncing}
      className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
    >
      {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {syncing ? "Syncing…" : "Sync now"}
    </button>
  );

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadMsg(null);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      const r = await fetch("/api/market/pricelabs/upload", { method: "POST", body: fd });
      const b = (await r.json()) as {
        ok?: boolean;
        error?: string;
        area?: string;
        used?: { file: string; kind: string }[];
        skipped?: { file: string; reason: string }[];
        stats?: { metrics: number; pacing: number };
      };
      if (!r.ok || !b.ok) {
        setUploadMsg(b.error ?? `upload failed (${r.status})`);
      } else {
        const sk = b.skipped?.length ? ` · ${b.skipped.length} skipped` : "";
        setUploadMsg(
          `Updated ${b.area} from ${b.used?.length ?? 0} report(s): ${b.stats?.metrics ?? 0} month(s) history, ${b.stats?.pacing ?? 0} forward day(s)${sk}.`,
        );
        await load();
      }
    } catch (e) {
      setUploadMsg(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const ImportBtn = (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".csv,.pdf"
        hidden
        onChange={(e) => uploadFiles(e.target.files)}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        title="Upload your PriceLabs report files (CSV exports + PDF)"
        className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {uploading ? "Importing…" : "Import reports"}
      </button>
    </>
  );

  function ResultBanner() {
    if (!syncResult) return null;
    if (!syncResult.ok) {
      return (
        <p className="rounded-md border border-[hsl(var(--danger))]/30 bg-[hsl(var(--danger))]/10 px-3 py-2 text-[11px] text-[hsl(var(--danger))]">
          Sync failed: {syncResult.reason ?? "unknown error"}
        </p>
      );
    }
    return (
      <div className="space-y-1.5">
        <p className="text-[11px] text-muted-foreground">
          Synced {syncResult.synced.length} area(s)
          {syncResult.filterLabel ? ` · ${syncResult.filterLabel}` : ""}
          {syncResult.failed.length > 0 ? ` · ${syncResult.failed.length} failed` : ""}
        </p>
        {syncResult.failed.map((f) => (
          <p
            key={f.neighborhood}
            className="rounded-md border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 px-3 py-1.5 text-[11px] text-foreground"
          >
            <span className="font-medium">{f.neighborhood || "(all Tel Aviv)"}:</span> {f.error}
          </p>
        ))}
      </div>
    );
  }

  if (loading) return <p className="text-xs text-muted-foreground">Loading market data…</p>;

  const snapshots = resp?.snapshots ?? [];
  const source = resp?.source ?? "none";
  const isPL = source === "pricelabs";

  if (snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="text-sm font-medium">No market data yet</p>
          <p className="mx-auto max-w-md text-[12px] text-muted-foreground">
            Upload your PriceLabs report files — the CSV exports (market history,
            occupancy, prices, supply &amp; demand) — and the dashboard updates.
            {resp?.configured ? " Or pick a unit type and Sync now to pull AirROI." : ""}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {ImportBtn}
            {resp?.configured ? (
              <>
                {BedroomSelect}
                {SyncBtn}
              </>
            ) : null}
          </div>
          {uploadMsg && <p className="text-[11px] text-muted-foreground">{uploadMsg}</p>}
          {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}
          <div className="mx-auto max-w-xl text-left">
            <ResultBanner />
          </div>
        </CardContent>
      </Card>
    );
  }

  const snap = snapshots.find((s) => s.neighborhood === selected) ?? snapshots[0];
  const areaName = snap.marketName || snap.neighborhood || "Tel Aviv";
  const cur = snap.currency || "ILS";
  const sym = cur === "ILS" ? "₪" : cur === "USD" ? "$" : "";
  const s = snap.summary;
  const mn = snap.minNights[0];

  // Our own portfolio series, overlaid on the market charts ("ours vs. market").
  const ours = resp?.ours;
  const ourMonthly = new Map((ours?.monthly ?? []).map((o) => [o.month, o]));
  const ourFwd = new Map((ours?.forwardOcc ?? []).map((p) => [p.date, p.occupancy]));
  const ourLos = new Map((ours?.los ?? []).map((b) => [b.bucket, b.share]));
  const ourFwdRate = new Map((ours?.forwardRate ?? []).map((p) => [p.date, p.rate]));
  const hasOurMonthly = (ours?.monthly?.length ?? 0) > 0;
  const hasOurFwd = (ours?.forwardOcc?.length ?? 0) > 0;
  const hasOurRate = (ours?.forwardRate?.length ?? 0) > 0;
  const hasOurLos = !!ours?.los?.some((b) => b.share > 0);

  const histOcc = snap.metrics.map((m) => {
    const o = ourMonthly.get(m.date.slice(0, 7));
    return { label: monthLabel(m.date), occupancy: Math.round(m.occupancy * 100), ours: o ? Math.round(o.occupancy * 100) : null };
  });
  const histRate = snap.metrics.map((m) => {
    const o = ourMonthly.get(m.date.slice(0, 7));
    return {
      label: monthLabel(m.date),
      adr: Math.round(m.average_daily_rate),
      revpar: Math.round(m.revpar),
      ourAdr: o ? o.adr : null,
      ourRevpar: o ? o.revpar : null,
    };
  });
  const occData = snap.pacing.map((p) => ({
    label: shortDate(p.date),
    occupancy: Math.round(p.fill_rate * 100),
    ours: ourFwd.has(p.date) ? Math.round((ourFwd.get(p.date) as number) * 100) : null,
  }));
  const rateData = snap.pacing.map((p) => ({
    label: shortDate(p.date),
    booked: Math.round(p.booked_rate_avg),
    available: Math.round(p.available_rate_avg),
    ours: ourFwdRate.get(p.date) ?? null,
  }));

  const bc = snap.extras?.bookingCurves ?? [];
  const curMonth = bcMonth && bc.some((m) => m.month === bcMonth) ? bcMonth : (bc[0]?.month ?? null);
  const bcPoints = bc.find((m) => m.month === curMonth)?.points ?? [];
  // Merge our pickup curve (by days-out) with the market's for the selected month.
  const ourPickMonth = (ours?.pickup ?? []).find((p) => p.month === monthKey(curMonth));
  const hasOurPick = !!ourPickMonth?.points?.length;
  const mktByW = new Map(bcPoints.map((p) => [p.w, p]));
  const oursByW = new Map((ourPickMonth?.points ?? []).map((p) => [p.w, p.occ]));
  const bcData = Array.from(new Set([...bcPoints.map((p) => p.w), ...(ourPickMonth?.points ?? []).map((p) => p.w)]))
    .sort((a, b) => a - b)
    .map((w) => ({ w, o: mktByW.get(w)?.o ?? null, ly: mktByW.get(w)?.ly ?? null, ours: oursByW.get(w) ?? null }));
  const losData = (snap.extras?.los ?? []).map((b) => ({ label: b.bucket, share: b.share, bnp: b.bnp, ours: ourLos.get(b.bucket) ?? null }));
  const tbl = snap.extras?.summaryTable ?? null;

  const ourByBed = new Map((ours?.byBedroom ?? []).map((b) => [b.label, b]));
  const ourBedAll = ours?.byBedroom ?? [];
  const ourBedCount = ourBedAll.reduce((s, b) => s + b.count, 0);
  const ourAgg = ourBedCount
    ? {
        count: ourBedCount,
        adr: Math.round(ourBedAll.reduce((s, b) => s + b.adr * b.count, 0) / ourBedCount),
        occupancy: Math.round(ourBedAll.reduce((s, b) => s + b.occupancy * b.count, 0) / ourBedCount),
      }
    : null;
  const ourForCategory = (category: string) =>
    category.includes("&") ? ourAgg : (ourByBed.get(category) ?? null);
  const hasOurBed = ourBedAll.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {snapshots.length > 1 ? (
            <select
              value={snap.neighborhood}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
            >
              {snapshots.map((x) => (
                <option key={x.neighborhood} value={x.neighborhood}>
                  {x.marketName || x.neighborhood || "Tel Aviv"}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-medium">{areaName}</span>
          )}
          <Badge variant="success">live · {isPL ? "PriceLabs" : "AirROI"}</Badge>
          {snap.filterLabel && <Badge variant="info">{snap.filterLabel}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] text-muted-foreground">updated {fmtRel(snap.fetchedAt)}</span>
          {!isPL && (
            <>
              {BedroomSelect}
              {SyncBtn}
            </>
          )}
          {ImportBtn}
        </div>
      </div>

      {uploadMsg && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {uploadMsg}
        </p>
      )}
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}
      <ResultBanner />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Occupancy" value={s ? `${(s.occupancy * 100).toFixed(0)}%` : "—"} sub="market avg" />
        <Tile label="ADR" value={s ? `${sym}${Math.round(s.average_daily_rate)}` : "—"} sub="avg daily rate" />
        <Tile label="RevPAR" value={s ? `${sym}${Math.round(s.rev_par)}` : "—"} sub="rev / avail. night" />
        <Tile label="Min-nights" value={s ? `${s.min_nights.toFixed(1)}n` : "—"} sub={mn ? `median ${mn.p50}n` : "market"} />
        <Tile label="Booking lead" value={s ? `${s.booking_lead_time.toFixed(0)}d` : "—"} sub="avg days ahead" />
        <Tile label="Length of stay" value={s ? `${s.length_of_stay.toFixed(1)}n` : "—"} sub="market avg" />
        <Tile label="Active listings" value={s ? s.active_listings_count.toLocaleString() : "—"} sub="in market" />
        <Tile label="Est. revenue" value={s ? `${sym}${Math.round(s.revenue).toLocaleString()}` : "—"} sub="market, period" />
      </section>

      <ChartCard
        title="Occupancy — 12-month history"
        desc="Market occupancy by month (the seasonality the engine learns from)."
        empty={histOcc.length === 0}
      >
        <LineChart data={histOcc} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={AXIS} />
          <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} stroke={AXIS} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${v}%`, String(n)]} />
          <Line type="monotone" dataKey="occupancy" name="Market" stroke="#2563eb" strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasOurMonthly && (
            <Line type="monotone" dataKey="ours" name="Ours" stroke="#ea580c" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          )}
        </LineChart>
      </ChartCard>

      <ChartCard
        title="ADR & RevPAR — 12-month history"
        desc={`Average daily rate and revenue-per-available-night by month (${cur}).`}
        empty={histRate.length === 0}
      >
        <LineChart data={histRate} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={AXIS} />
          <YAxis tick={{ fontSize: 10 }} stroke={AXIS} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${sym}${v}`, String(n)]} />
          <Line type="monotone" dataKey="adr" name="ADR" stroke="#16a34a" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="revpar" name="RevPAR" stroke="#9333ea" strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasOurMonthly && (
            <Line type="monotone" dataKey="ourAdr" name="ADR (ours)" stroke="#16a34a" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
          )}
          {hasOurMonthly && (
            <Line type="monotone" dataKey="ourRevpar" name="RevPAR (ours)" stroke="#9333ea" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
          )}
        </LineChart>
      </ChartCard>

      <ChartCard
        title="Forward occupancy (booking pace)"
        desc="Share of comparable listings already booked, by check-in date — higher = a tighter market."
        empty={occData.length === 0}
      >
        <AreaChart data={occData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={AXIS} />
          <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} stroke={AXIS} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${v}%`, String(n)]} />
          <Area type="monotone" dataKey="occupancy" name="Market" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
          {hasOurFwd && (
            <Line type="monotone" dataKey="ours" name="Ours" stroke="#ea580c" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          )}
        </AreaChart>
      </ChartCard>

      <ChartCard
        title="Forward market rate"
        desc={`Average booked vs. available nightly rate by check-in date (${cur}).`}
        empty={rateData.length === 0}
      >
        <LineChart data={rateData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={AXIS} />
          <YAxis tick={{ fontSize: 10 }} stroke={AXIS} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${sym}${v}`} />
          <Line type="monotone" dataKey="booked" name="Booked" stroke="#16a34a" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="available" name="Available" stroke="#64748b" strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasOurRate && (
            <Line type="monotone" dataKey="ours" name="Ours (booked)" stroke="#ea580c" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          )}
        </LineChart>
      </ChartCard>

      {bc.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Booking pickup curve</CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  How {curMonth} fills as check-in approaches — this year vs. last year.
                </p>
              </div>
              {bc.length > 1 && (
                <select
                  value={curMonth ?? ""}
                  onChange={(e) => setBcMonth(e.target.value)}
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs"
                >
                  {bc.map((m) => (
                    <option key={m.month} value={m.month}>
                      {m.month}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {bcData.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No data for this month.</p>
            ) : (
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={bcData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis
                      dataKey="w"
                      type="number"
                      reversed
                      tick={{ fontSize: 10 }}
                      stroke={AXIS}
                      tickFormatter={(v) => `${v}d`}
                    />
                    <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} stroke={AXIS} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      labelFormatter={(l) => `${l} days before check-in`}
                      formatter={(v, n) => [`${v}%`, String(n)]}
                    />
                    <Line type="monotone" dataKey="o" name="Market" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    <Line type="monotone" dataKey="ly" name="Market LY" stroke="#94a3b8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
                    {hasOurPick && (
                      <Line type="monotone" dataKey="ours" name="Ours" stroke="#ea580c" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {losData.length > 0 && (
        <ChartCard
          title="Length-of-stay mix"
          desc="Share of market bookings by length of stay — more weight on 7+ nights means a longer-stay market."
          empty={false}
        >
          <BarChart data={losData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke={AXIS} interval={0} />
            <YAxis unit="%" tick={{ fontSize: 10 }} stroke={AXIS} />
            <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${v}%`, String(n)]} />
            <Bar dataKey="share" name="Market" fill="#2563eb" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            {hasOurLos && <Bar dataKey="ours" name="Ours" fill="#ea580c" radius={[3, 3, 0, 0]} isAnimationActive={false} />}
          </BarChart>
        </ChartCard>
      )}

      {tbl && tbl.rows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>By bedroom</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {hasOurBed ? "Market vs. your portfolio by unit size" : "Latest-month market comparison by unit size"} ({cur}).
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1 font-medium">Segment</th>
                  <th className="py-1 text-right font-medium">Occupancy</th>
                  <th className="py-1 text-right font-medium">ADR</th>
                  <th className="py-1 text-right font-medium">RevPAR</th>
                  <th className="py-1 text-right font-medium">LOS</th>
                  <th className="py-1 text-right font-medium">Book window</th>
                  {hasOurBed && <th className="py-1 text-right font-medium text-primary">Our units</th>}
                  {hasOurBed && <th className="py-1 text-right font-medium text-primary">Our ADR</th>}
                </tr>
              </thead>
              <tbody>
                {tbl.rows.map((r) => {
                  const o = ourForCategory(r.category);
                  return (
                    <tr key={r.category} className="border-t border-border/60">
                      <td className="py-1.5 font-medium">{r.category}</td>
                      <td className="py-1.5 text-right">{Math.round(r.occupancy)}%</td>
                      <td className="py-1.5 text-right">{sym}{Math.round(r.adr)}</td>
                      <td className="py-1.5 text-right">{sym}{Math.round(r.revpar)}</td>
                      <td className="py-1.5 text-right">{r.los.toFixed(1)}n</td>
                      <td className="py-1.5 text-right">{Math.round(r.bookingWindow)}d</td>
                      {hasOurBed && <td className="py-1.5 text-right text-primary">{o ? o.count : "—"}</td>}
                      {hasOurBed && <td className="py-1.5 text-right text-primary">{o ? `${sym}${Math.round(o.adr)}` : "—"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
