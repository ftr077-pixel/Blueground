"use client";

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboard } from "./use-dashboard";
import { bestPage, CHART, fmtMoney, monthlyPrice, nightsLabel } from "@/lib/revenue";

interface Point {
  x: number; // price
  y: number; // page
  label: string;
}

function PointTip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] shadow-sm">
      <div className="font-medium">{p.label}</div>
      <div className="text-muted-foreground">
        {fmtMoney(p.x)} · page {p.y}
      </div>
    </div>
  );
}

export function PricingRankPanel() {
  const { data, loading, error } = useDashboard();
  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const primary = data.primaryStay;
  const points: Point[] = data.listings
    .map((l) => ({ price: monthlyPrice(l, data.costDefaults), page: bestPage(l, primary), label: l.label }))
    .filter((p): p is { price: number; page: number; label: string } => p.price != null && p.page != null)
    .map((p) => ({ x: p.price, y: p.page, label: p.label }));

  // Simple read: average price on page 1 vs deeper, to see if price tracks rank.
  const p1 = points.filter((p) => p.y === 1);
  const deeper = points.filter((p) => p.y > 1);
  const avg = (arr: Point[]) => (arr.length ? arr.reduce((s, p) => s + p.x, 0) / arr.length : null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Price vs. search position — {nightsLabel(primary)}</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Each dot is a listing: its 1-month price (x) against its best page (y, page 1 at top).
            Use it to spot listings priced high yet ranking deep, or cheap ones already on page 1.
          </p>
        </CardHeader>
        <CardContent>
          {points.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No priced + ranked listings yet — run a scan first.
            </p>
          ) : (
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis
                    type="number"
                    dataKey="x"
                    name="price"
                    tick={{ fontSize: 10 }}
                    stroke={CHART.axis}
                    tickFormatter={(v) => fmtMoney(Number(v))}
                    label={{ value: "1-month price", position: "insideBottom", offset: -8, fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    name="page"
                    reversed
                    allowDecimals={false}
                    tick={{ fontSize: 10 }}
                    stroke={CHART.axis}
                    label={{ value: "page", angle: -90, position: "insideLeft", fontSize: 11 }}
                  />
                  <Tooltip content={<PointTip />} />
                  <Scatter data={points} fill={CHART.blue} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          <div>
            <div className="text-2xl font-semibold tracking-tight text-[hsl(var(--success))]">
              {fmtMoney(avg(p1))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Avg price · on page 1 ({p1.length})
            </div>
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight text-muted-foreground">
              {fmtMoney(avg(deeper))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Avg price · deeper ({deeper.length})
            </div>
          </div>
          <p className="max-w-md text-[11px] text-muted-foreground">
            Note: this compares your own listings&apos; prices and ranks. Competitor prices aren&apos;t
            captured yet — a future scraper change could add the market price at each position to make
            this a true price-vs-market view.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
