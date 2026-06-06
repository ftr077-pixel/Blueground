"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface HistoryPoint {
  runId: string;
  ts: string;
  bestRank: number | null;
  bestPage: number | null;
  price: number | null;
  available: boolean;
}

interface Resp {
  listing: { id: string; label: string; airbnbId: string };
  history: HistoryPoint[];
}

function fmt(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function ListingHistory({ id }: { id: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/visibility/history/${id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((b: Resp) => setData(b))
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="text-[11px] text-[hsl(var(--danger))]">{error || "not found"}</p>;

  const points = data.history.map((h) => ({ label: fmt(h.ts), rank: h.bestRank, price: h.price }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.listing.label}</h1>
        <p className="text-[11px] text-muted-foreground">listing {data.listing.airbnbId}</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Price vs. position over time</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Rank (left axis, higher = better) against the price it&apos;s showing (right axis). Drop
            the price, run a scan, and watch the rank line climb.
          </p>
        </CardHeader>
        <CardContent>
          {points.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No scans yet for this listing.</p>
          ) : (
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" />
                  <YAxis
                    yAxisId="rank"
                    reversed
                    allowDecimals={false}
                    tick={{ fontSize: 10 }}
                    stroke="#2563eb"
                    label={{ value: "rank", angle: -90, position: "insideLeft", fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="price"
                    orientation="right"
                    tick={{ fontSize: 10 }}
                    stroke="#16a34a"
                  />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Line yAxisId="rank" type="monotone" dataKey="rank" name="Rank" stroke="#2563eb" strokeWidth={2} connectNulls={false} />
                  <Line yAxisId="price" type="monotone" dataKey="price" name="Price" stroke="#16a34a" strokeWidth={2} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Scan history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Position</th>
                  <th className="px-3 py-2 text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {data.history
                  .slice()
                  .reverse()
                  .map((h) => (
                    <tr key={h.runId} className="border-t border-border/60">
                      <td className="px-3 py-2 text-muted-foreground">
                        {new Date(h.ts).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        {h.bestRank != null
                          ? `page ${h.bestPage} · rank ${h.bestRank}`
                          : h.available
                            ? "not in top 280"
                            : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {h.price != null ? `₪${Math.round(h.price).toLocaleString()}` : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
