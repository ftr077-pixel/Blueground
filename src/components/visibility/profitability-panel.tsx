"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboard } from "./use-dashboard";
import { bestPage, economics, fmtMoney, fmtPct, nightsLabel } from "@/lib/revenue";

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

export function ProfitabilityPanel() {
  const { data, loading, error } = useDashboard();
  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const primary = data.primaryStay;
  const rows = data.listings
    .map((l) => ({ l, e: economics(l), page: bestPage(l, primary) }))
    .sort((a, b) => (b.e.profit ?? -Infinity) - (a.e.profit ?? -Infinity));

  const withProfit = rows.filter((r) => r.e.profit != null);
  const totRev = withProfit.reduce((s, r) => s + (r.e.revenue ?? 0), 0);
  const totCost = withProfit.reduce((s, r) => s + (r.e.cost ?? 0), 0);
  const totProfit = totRev - totCost;
  const avgMargin = totRev ? totProfit / totRev : null;
  const missing = rows.filter((r) => !r.e.costsKnown).length;
  const losers = withProfit.filter((r) => (r.e.profit ?? 0) < 0).length;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          <Stat label="Monthly revenue" value={fmtMoney(totRev)} />
          <Stat label="Monthly cost" value={fmtMoney(totCost)} tone="text-muted-foreground" />
          <Stat
            label="Monthly profit"
            value={fmtMoney(totProfit)}
            tone={totProfit >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"}
          />
          <Stat label="Avg margin" value={fmtPct(avgMargin)} />
          {losers > 0 && <Stat label="Running at a loss" value={String(losers)} tone="text-[hsl(var(--danger))]" />}
        </CardContent>
      </Card>

      {missing > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {missing} listing(s) missing cost inputs — set rent / utilities / cleaning in{" "}
          <Link href="/visibility/manage" className="text-primary hover:underline">
            Manage
          </Link>{" "}
          to include them here.
        </p>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Profit by listing (per month)</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Revenue = the 1-month price from the latest scan. Cost = rent + utilities + cleaning.
            Profit = revenue − cost.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Listing</th>
                  <th className="px-3 py-2 text-center">★ {nightsLabel(primary)}</th>
                  <th className="px-3 py-2 text-right">Revenue</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Profit</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ l, e, page }) => (
                  <tr key={l.id} className="border-t border-border/60 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`/visibility/listing/${l.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {l.label}
                      </Link>
                      <div className="text-[10px] text-muted-foreground">{l.airbnbId}</div>
                    </td>
                    <td className="px-3 py-2 text-center font-mono">{page != null ? `p${page}` : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtMoney(e.revenue)}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {e.costsKnown ? fmtMoney(e.cost) : <span className="italic">set costs</span>}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        e.profit == null
                          ? "text-muted-foreground"
                          : e.profit >= 0
                            ? "text-[hsl(var(--success))]"
                            : "text-[hsl(var(--danger))]"
                      }`}
                    >
                      {fmtMoney(e.profit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmtPct(e.margin)}</td>
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
