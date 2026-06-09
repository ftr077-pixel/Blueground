"use client";

import { useEffect, useState } from "react";
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
  booked_count: number;
  available_count: number;
  booked_rate_avg: number;
  available_rate_avg: number;
  fill_rate: number;
}
interface MinNightsPoint {
  date: string;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
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
}
interface MarketResp {
  source: string;
  configured: boolean;
  snapshots: Snapshot[];
}

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtRel(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </Card>
  );
}

export function MarketAnalyticsPanel() {
  const [resp, setResp] = useState<MarketResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/market", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: MarketResp) => {
        setResp(b);
        if (b.snapshots.length) setSelected(b.snapshots[0].neighborhood);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">Loading market data…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;

  const snapshots = resp?.snapshots ?? [];
  if (snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm font-medium">No market data yet</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-muted-foreground">
            {resp?.configured
              ? "AirROI is configured — run the market sync to pull data: "
              : "Set AIRROI_API_KEY, then run the market sync: "}
            <code>POST /api/market/sync</code> (the daily cron does this automatically).
          </p>
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

  const occData = snap.pacing.map((p) => ({
    label: shortDate(p.date),
    occupancy: Math.round(p.fill_rate * 100),
  }));
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
        </div>
        <span className="text-[11px] text-muted-foreground">
          updated {fmtRel(snap.fetchedAt)} · {snap.pacing.length} forward days
        </span>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Occupancy" value={s ? `${(s.occupancy * 100).toFixed(0)}%` : "—"} sub="market avg" />
        <Tile label="ADR" value={s ? `${sym}${Math.round(s.average_daily_rate)}` : "—"} sub="avg daily rate" />
        <Tile label="RevPAR" value={s ? `${sym}${Math.round(s.rev_par)}` : "—"} sub="rev / available night" />
        <Tile label="Min-nights" value={s ? `${s.min_nights.toFixed(1)}n` : "—"} sub={mn ? `median ${mn.p50}n` : "market"} />
        <Tile label="Booking lead" value={s ? `${s.booking_lead_time.toFixed(0)}d` : "—"} sub="avg days ahead" />
        <Tile label="Length of stay" value={s ? `${s.length_of_stay.toFixed(1)}n` : "—"} sub="market avg" />
        <Tile label="Active listings" value={s ? s.active_listings_count.toLocaleString() : "—"} sub="in market" />
        <Tile label="Est. revenue" value={s ? `${sym}${Math.round(s.revenue).toLocaleString()}` : "—"} sub="market, period" />
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Forward occupancy (booking pace)</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Share of comparable listings already booked, by check-in date — higher = a tighter
            market the engine prices up into.
          </p>
        </CardHeader>
        <CardContent>
          {occData.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No forward pacing data.</p>
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <AreaChart data={occData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => [`${v}%`, "Occupancy"]} />
                  <Area type="monotone" dataKey="occupancy" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Forward market rate</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Average booked vs. available nightly rate by check-in date ({cur}) — the seasonality
            signal feeding the pricing engine.
          </p>
        </CardHeader>
        <CardContent>
          {rateData.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No forward rate data.</p>
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={rateData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${sym}${v}`} />
                  <Line type="monotone" dataKey="booked" name="Booked" stroke="#16a34a" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="available" name="Available" stroke="#64748b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
