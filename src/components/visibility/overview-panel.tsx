"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboard } from "./use-dashboard";
import {
  availableForStay,
  bestPage,
  CHART,
  economics,
  fmtMoney,
  fmtPct,
  nightsLabel,
} from "@/lib/revenue";

interface TrendPoint {
  ts: string;
  appearing: number;
  page1: number;
  available: number;
}

function fmtDay(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

const SUBTABS = [
  { href: "/visibility", label: "Search & Profit" },
  { href: "/visibility/analytics", label: "Position Trends" },
  { href: "/visibility/pricing", label: "Pricing vs Rank" },
  { href: "/visibility/portfolio", label: "Portfolio" },
];

export function OverviewPanel() {
  const { data, loading, error } = useDashboard();
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  useEffect(() => {
    fetch("/api/visibility/analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { trend?: TrendPoint[] }) => setTrend(b.trend ?? []))
      .catch(() => undefined);
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const primary = data.primaryStay;
  const eco = data.listings.map((l) => economics(l, data.costDefaults));
  const totRev = eco.reduce((s, e) => s + (e.revenue ?? 0), 0);
  const totProfit = eco.reduce((s, e) => s + (e.profit ?? 0), 0);
  const knownRev = eco.filter((e) => e.profit != null).reduce((s, e) => s + (e.revenue ?? 0), 0);
  const avgMargin = knownRev ? totProfit / knownRev : null;
  const ranked = data.listings.map((l) => bestPage(l, primary)).filter((x): x is number => x != null);
  const page1 = ranked.filter((x) => x === 1).length;
  const avail = data.listings.filter((l) => availableForStay(l, primary)).length;
  const page1Share = data.listings.length ? page1 / data.listings.length : null;

  const barData = data.listings
    .map((l) => ({
      name: l.label.length > 14 ? `${l.label.slice(0, 13)}…` : l.label,
      profit: economics(l, data.costDefaults).profit,
    }))
    .filter((d): d is { name: string; profit: number } => d.profit != null)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 8);

  const lineData = trend.map((t) => ({
    label: fmtDay(t.ts),
    appearing: t.appearing,
    page1: t.page1,
    available: t.available,
  }));

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          <Stat label="Monthly revenue" value={fmtMoney(totRev)} />
          <Stat
            label="Monthly profit"
            value={fmtMoney(totProfit)}
            tone={totProfit >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
          />
          <Stat label="Avg margin" value={fmtPct(avgMargin)} />
          <Stat label={`Page 1 · ${nightsLabel(primary)}`} value={fmtPct(page1Share)} tone="text-primary" />
          <Stat label="Available" value={String(avail)} tone="text-[hsl(var(--success))]" />
          <Stat label="Listings" value={String(data.listings.length)} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {SUBTABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {t.label} →
          </Link>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Top earners (monthly profit)</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Profit = 1-month price − rent − utilities − cleaning. Set costs in Manage to populate.
            </p>
          </CardHeader>
          <CardContent>
            {barData.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No profit data yet — add listing costs in Manage and run a scan.
              </p>
            ) : (
              <div style={{ width: "100%", height: 280 }}>
                <ResponsiveContainer>
                  <BarChart data={barData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke={CHART.axis} interval={0} angle={-20} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 10 }} stroke={CHART.axis} tickFormatter={(v) => fmtMoney(Number(v))} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(value) => fmtMoney(value == null ? null : Number(value))}
                    />
                    <Bar dataKey="profit" radius={[3, 3, 0, 0]}>
                      {barData.map((d, i) => (
                        <Cell key={i} fill={d.profit >= 0 ? CHART.green : CHART.red} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Visibility over time</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Listings available, in search, and on page 1 — one point per scan.
            </p>
          </CardHeader>
          <CardContent>
            {lineData.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No scans yet.</p>
            ) : (
              <div style={{ width: "100%", height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={lineData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={CHART.axis} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} stroke={CHART.axis} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="available" name="Available" stroke={CHART.slate} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="appearing" name="In search" stroke={CHART.blue} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="page1" name="Page 1" stroke={CHART.green} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
