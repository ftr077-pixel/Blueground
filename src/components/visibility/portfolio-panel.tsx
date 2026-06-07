"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboard } from "./use-dashboard";
import {
  availableForStay,
  bestPage,
  economics,
  fmtMoney,
  monthlyPrice,
  nightsLabel,
} from "@/lib/revenue";
import { formatRelative } from "@/lib/utils";

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

export function PortfolioPanel() {
  const { data, loading, error } = useDashboard();
  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  if (!data) return null;

  const primary = data.primaryStay;
  const byProfile = data.profiles.map((p) => {
    const ls = data.listings.filter((l) => l.profileId === p.id);
    const ranked = ls.map((l) => bestPage(l, primary)).filter((x): x is number => x != null);
    return {
      p,
      count: ls.length,
      avail: ls.filter((l) => availableForStay(l, primary)).length,
      inSearch: ranked.length,
      page1: ranked.filter((x) => x === 1).length,
      avgPage: ranked.length ? ranked.reduce((s, x) => s + x, 0) / ranked.length : null,
      revenue: ls.reduce((s, l) => s + (monthlyPrice(l) ?? 0), 0),
      profit: ls.reduce((s, l) => s + (economics(l, data.costDefaults).profit ?? 0), 0),
    };
  });

  const neverScanned = data.listings.filter((l) => l.latest.length === 0).length;
  const totalAvail = data.listings.filter((l) => availableForStay(l, primary)).length;
  const coverage = data.listings.length ? Math.round((100 * totalAvail) / data.listings.length) : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          <Stat label="Listings" value={String(data.listings.length)} />
          <Stat label="Profiles" value={String(data.profiles.length)} />
          <Stat
            label={`Available · ${nightsLabel(primary)}`}
            value={String(totalAvail)}
            tone="text-[hsl(var(--success))]"
          />
          <Stat label="Coverage" value={coverage != null ? `${coverage}%` : "—"} />
          {neverScanned > 0 && (
            <Stat label="Never scanned" value={String(neverScanned)} tone="text-[hsl(var(--warning))]" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>By profile</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Rollup per search profile (area). Availability, search presence and page-1 are for{" "}
            {nightsLabel(primary)}; revenue/profit are monthly.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Profile</th>
                  <th className="px-3 py-2 text-right">Listings</th>
                  <th className="px-3 py-2 text-right">Available</th>
                  <th className="px-3 py-2 text-right">In search</th>
                  <th className="px-3 py-2 text-right">Page 1</th>
                  <th className="px-3 py-2 text-right">Avg page</th>
                  <th className="px-3 py-2 text-right">Revenue</th>
                  <th className="px-3 py-2 text-right">Profit</th>
                  <th className="px-3 py-2 text-right">Last scan</th>
                </tr>
              </thead>
              <tbody>
                {byProfile.map((r) => (
                  <tr key={r.p.id} className="border-t border-border/60">
                    <td className="px-3 py-2 font-medium">{r.p.label}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.count}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.avail}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.inSearch}</td>
                    <td className="px-3 py-2 text-right font-mono text-[hsl(var(--success))]">{r.page1}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.avgPage != null ? r.avgPage.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmtMoney(r.revenue)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtMoney(r.profit)}</td>
                    <td className="px-3 py-2 text-right text-[10px] text-muted-foreground">
                      {r.p.lastRunAt ? formatRelative(r.p.lastRunAt) : "never"}
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
