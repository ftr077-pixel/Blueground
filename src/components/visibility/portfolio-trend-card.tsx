"use client";

import { useEffect, useState } from "react";
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

interface TrendPoint {
  ts: string;
  listings: number;
  appearing: number;
  page1: number;
  available: number;
}

function fmt(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** Portfolio visibility over time — listings available, appearing in search,
 *  and on page 1; one point per scan. Lives at the top of Search & Profit. */
export function PortfolioTrendCard() {
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/visibility/analytics", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { trend: TrendPoint[] }) => setTrend(b.trend ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"));
  }, []);

  const data = (trend ?? []).map((t) => ({
    label: fmt(t.ts),
    appearing: t.appearing,
    page1: t.page1,
    available: t.available,
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Portfolio visibility over time</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Listings available, appearing in search, and on page 1 — one point per scan.
        </p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>
        ) : trend == null ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : data.length === 0 ? (
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
  );
}
