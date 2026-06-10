"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
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
}
interface MarketResp {
  source: string;
  configured: boolean;
  bedrooms: string;
  snapshots: Snapshot[];
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

  if (snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="text-sm font-medium">No market data yet</p>
          <p className="mx-auto max-w-md text-[12px] text-muted-foreground">
            {resp?.configured
              ? "AirROI is connected. Pick a unit type and click Sync now."
              : "AirROI isn't configured yet (set AIRROI_API_KEY). Once it is, Sync now pulls the data."}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {BedroomSelect}
            {SyncBtn}
          </div>
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

  const histOcc = snap.metrics.map((m) => ({ label: monthLabel(m.date), occupancy: Math.round(m.occupancy * 100) }));
  const histRate = snap.metrics.map((m) => ({
    label: monthLabel(m.date),
    adr: Math.round(m.average_daily_rate),
    revpar: Math.round(m.revpar),
  }));
  const occData = snap.pacing.map((p) => ({ label: shortDate(p.date), occupancy: Math.round(p.fill_rate * 100) }));
  const rateData = snap.pacing.map((p) => ({
    label: shortDate(p.date),
    booked: Math.round(p.booked_rate_avg),
    available: Math.round(p.available_rate_avg),
  }));

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
          <Badge variant="success">live · AirROI</Badge>
          {snap.filterLabel && <Badge variant="info">{snap.filterLabel}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] text-muted-foreground">updated {fmtRel(snap.fetchedAt)}</span>
          {BedroomSelect}
          {SyncBtn}
        </div>
      </div>

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
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => [`${v}%`, "Occupancy"]} />
          <Line type="monotone" dataKey="occupancy" stroke="#2563eb" strokeWidth={2} dot={false} />
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
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${sym}${v}`} />
          <Line type="monotone" dataKey="adr" name="ADR" stroke="#16a34a" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="revpar" name="RevPAR" stroke="#9333ea" strokeWidth={2} dot={false} />
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
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => [`${v}%`, "Occupancy"]} />
          <Area type="monotone" dataKey="occupancy" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2} />
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
          <Line type="monotone" dataKey="booked" name="Booked" stroke="#16a34a" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="available" name="Available" stroke="#64748b" strokeWidth={2} dot={false} />
        </LineChart>
      </ChartCard>
    </div>
  );
}
