"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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

interface TrendPoint {
  ts: string;
  listings: number;
  appearing: number;
  page1: number;
  available: number;
}

interface Mover {
  listingId: string;
  label: string;
  airbnbId: string;
  latestRank: number | null;
  prevRank: number | null;
  delta: number | null;
  kind: "up" | "down" | "entered" | "left";
}

function fmt(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function AnalyticsPanel() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/visibility/analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { trend: TrendPoint[]; movers: Mover[] }) => {
        setTrend(b.trend);
        setMovers(b.movers);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">Loading analytics…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;

  const data = trend.map((t) => ({
    label: fmt(t.ts),
    appearing: t.appearing,
    page1: t.page1,
    available: t.available,
  }));
  const climbers = movers.filter((m) => m.kind === "up");
  const droppers = movers.filter((m) => m.kind === "down");
  const entered = movers.filter((m) => m.kind === "entered");
  const left = movers.filter((m) => m.kind === "left");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Portfolio visibility over time</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Listings available, appearing in search, and on page 1 — one point per scan.
          </p>
        </CardHeader>
        <CardContent>
          {data.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No scans yet.</p>
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="available" name="Available" stroke="#64748b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="appearing" name="In search" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="page1" name="Page 1" stroke="#16a34a" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Movers since last scan</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Biggest rank changes between the two most recent scans.
          </p>
        </CardHeader>
        <CardContent>
          {movers.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Need at least two scans to compute movers.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <MoverList title="Climbed ↑" items={climbers} />
              <MoverList title="Dropped ↓" items={droppers} />
              {entered.length > 0 && <MoverList title="Entered results" items={entered} />}
              {left.length > 0 && <MoverList title="Fell out" items={left} />}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MoverList({ title, items }: { title: string; items: Mover[] }) {
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">none</p>
      ) : (
        <ul className="space-y-1">
          {items.map((m) => (
            <li
              key={m.listingId}
              className="flex items-center gap-2 rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5"
            >
              <Link
                href={`/visibility/listing/${m.listingId}`}
                className="truncate text-xs font-medium hover:text-primary"
              >
                {m.label}
              </Link>
              <span className="ml-auto">
                {m.kind === "up" && <Badge variant="success">▲ {m.delta}</Badge>}
                {m.kind === "down" && <Badge variant="danger">▼ {Math.abs(m.delta as number)}</Badge>}
                {m.kind === "entered" && <Badge variant="info">new · rank {m.latestRank}</Badge>}
                {m.kind === "left" && <Badge variant="muted">fell out</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
