"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Loader2, PlayCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatRelative } from "@/lib/utils";

interface UnitDto {
  id: string;
  name: string;
  neighborhood: string;
  bedrooms: number;
  baseRate: number;
  currentRate: number;
  occupancy30d: number;
  platform: string;
  lastRateChangeAt: string | null;
  minRate: number;
  maxRate: number;
  weeklyDiscountPct: number;
  monthlyDiscountPct: number;
  minStay: number;
  lowestMinStay: number;
}

interface RateBandDto {
  profileId: string;
  area: string;
  nights: number;
  stayLabel: string;
  n: number;
  p25: number;
  p50: number;
  p75: number;
  currency: string;
}

interface MarketDto {
  bands: RateBandDto[];
  minNights: { median: number | null; n: number };
}

interface RuleDto {
  key: string;
  label: string;
  enabled: boolean;
  note: string;
}

interface MarketSnapshotDto {
  neighborhood: string;
  marketName: string | null;
  fetchedAt: string;
  currency: string | null;
  occupancy: number | null;
  adr: number | null;
  revpar: number | null;
  minNights: number | null;
  pacingDays: number;
}

interface MarketDataDto {
  source: "airroi" | "mock";
  configured: boolean;
  snapshots: MarketSnapshotDto[];
}

interface HistoryDto {
  id: string;
  unitId: string;
  ts: string;
  oldRate: number;
  newRate: number;
  deltaPct: number;
  reason: string;
  status: "applied" | "pending_approval" | "rejected";
}

interface RunSummary {
  ranAt: string;
  summary: { total: number; applied: number; flagged: number; noOps: number };
}

const STATUS_VARIANT: Record<HistoryDto["status"], "success" | "warning" | "muted"> = {
  applied: "success",
  pending_approval: "warning",
  rejected: "muted",
};

const STATUS_LABEL: Record<HistoryDto["status"], string> = {
  applied: "Applied",
  pending_approval: "Pending approval",
  rejected: "Rejected",
};

export function PricingPanel() {
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [history, setHistory] = useState<HistoryDto[]>([]);
  const [market, setMarket] = useState<MarketDto | null>(null);
  const [rules, setRules] = useState<RuleDto[]>([]);
  const [marketData, setMarketData] = useState<MarketDataDto | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/agents/pricing", { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as {
        units: UnitDto[];
        history: HistoryDto[];
        market?: MarketDto;
        rules?: RuleDto[];
        marketData?: MarketDataDto;
      };
      setUnits(body.units);
      setHistory(body.history);
      setMarket(body.market ?? null);
      setRules(body.rules ?? []);
      setMarketData(body.marketData ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/pricing/run", { method: "POST" });
      if (!res.ok) throw new Error(`run failed: ${res.status}`);
      const body = (await res.json()) as RunSummary;
      setLastRun(body);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to run");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Pricing Specialist · live</CardTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Real agent. Each pass scores demand + occupancy per unit, pins the result to the
              unit&apos;s floor/ceiling, recommends a min-stay (benchmarked vs. market), applies
              moves under ±15% directly, and escalates anything bigger to the Action Center (spec §5).
            </p>
          </div>
          <div className="flex items-center gap-2">
            {lastRun && (
              <span className="text-[10px] text-muted-foreground">
                last pass {formatRelative(lastRun.ranAt)} · {lastRun.summary.applied} applied ·{" "}
                {lastRun.summary.flagged} flagged
              </span>
            )}
            <button
              type="button"
              onClick={runNow}
              disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              Run pricing pass
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-2 text-[11px] text-[hsl(var(--danger))]">{error}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-5">
        {rules.length > 0 && (
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Pricing rule engine · {rules.filter((r) => r.enabled).length}/{rules.length} active
            </div>
            <div className="flex flex-wrap gap-1.5">
              {rules.map((r) => (
                <span
                  key={r.key}
                  title={r.note}
                  className={cn(
                    "inline-flex items-center rounded-md border px-2 py-1 text-[10px]",
                    r.enabled
                      ? "border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/10 text-foreground"
                      : "border-border bg-muted/30 text-muted-foreground line-through",
                  )}
                >
                  {r.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {marketData && (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Market data · feeding the engine
              </span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px]",
                  marketData.source === "airroi"
                    ? "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {marketData.source === "airroi" ? "live · AirROI" : "sample data"}
              </span>
            </div>
            {marketData.snapshots.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Using built-in sample signals. Set <code>AIRROI_API_KEY</code> and run the market
                sync (<code>POST /api/market/sync</code>) to pull live AirROI data into the engine.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Area</th>
                      <th className="px-3 py-2 text-right">Occ</th>
                      <th className="px-3 py-2 text-right">ADR</th>
                      <th className="px-3 py-2 text-right">RevPAR</th>
                      <th className="px-3 py-2 text-right">Min-nights</th>
                      <th className="px-3 py-2 text-right">Pacing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {marketData.snapshots.map((s) => (
                      <tr key={s.neighborhood} className="border-t border-border/60">
                        <td className="px-3 py-2">{s.neighborhood}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {s.occupancy != null ? `${(s.occupancy * 100).toFixed(0)}%` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {s.adr != null ? `₪${Math.round(s.adr)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {s.revpar != null ? `₪${Math.round(s.revpar)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {s.minNights != null ? `${s.minNights.toFixed(1)}n` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {s.pacingDays}d
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Portfolio · {units.length} units
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Unit</th>
                  <th className="px-3 py-2 text-left">Hood</th>
                  <th className="px-3 py-2 text-right">Base</th>
                  <th className="px-3 py-2 text-right">Current</th>
                  <th className="px-3 py-2 text-right">Floor / Ceil</th>
                  <th className="px-3 py-2 text-right">₪/mo</th>
                  <th className="px-3 py-2 text-right">Occ 30d</th>
                  <th className="px-3 py-2 text-right">Min-stay</th>
                  <th className="px-3 py-2 text-left">Last move</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => {
                  const delta = ((u.currentRate - u.baseRate) / u.baseRate) * 100;
                  const effMonthly = Math.round(u.currentRate * 30 * (1 - u.monthlyDiscountPct));
                  const atFloor = u.currentRate <= u.minRate;
                  const atCeil = u.currentRate >= u.maxRate;
                  return (
                    <tr key={u.id} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {u.id} · {u.platform}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{u.neighborhood}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        ₪{u.baseRate}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        <span className="font-semibold">₪{u.currentRate}</span>
                        {Math.abs(delta) >= 0.5 && (
                          <span
                            className={cn(
                              "ml-1.5 text-[10px]",
                              delta >= 0
                                ? "text-[hsl(var(--success))]"
                                : "text-[hsl(var(--danger))]",
                            )}
                          >
                            {delta >= 0 ? "+" : ""}
                            {delta.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] text-muted-foreground">
                        ₪{u.minRate}–₪{u.maxRate}
                        {atFloor && (
                          <span className="ml-1 text-[hsl(var(--danger))]">floor</span>
                        )}
                        {atCeil && (
                          <span className="ml-1 text-[hsl(var(--success))]">ceil</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        ₪{effMonthly.toLocaleString()}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          −{Math.round(u.monthlyDiscountPct * 100)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {(u.occupancy30d * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {u.minStay}n
                        {u.minStay > u.lowestMinStay && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            ≥{u.lowestMinStay}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted-foreground">
                        {u.lastRateChangeAt ? formatRelative(u.lastRateChangeAt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Market rate bands · from visibility scans
            </span>
            {market?.minNights.median != null && (
              <span className="text-[10px] text-muted-foreground">
                competitor min-stay median {market.minNights.median}n (n={market.minNights.n})
              </span>
            )}
          </div>
          {!market || market.bands.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No competitor price data yet — run a visibility scan to populate nightly rate bands.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Area</th>
                    <th className="px-3 py-2 text-left">Stay</th>
                    <th className="px-3 py-2 text-right">n</th>
                    <th className="px-3 py-2 text-right">P25</th>
                    <th className="px-3 py-2 text-right">Median</th>
                    <th className="px-3 py-2 text-right">P75</th>
                  </tr>
                </thead>
                <tbody>
                  {market.bands.map((b) => (
                    <tr
                      key={`${b.profileId}-${b.nights}`}
                      className="border-t border-border/60"
                    >
                      <td className="px-3 py-2">{b.area}</td>
                      <td className="px-3 py-2 text-muted-foreground">{b.stayLabel}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        {b.n}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        ₪{b.p25.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        ₪{b.p50.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        ₪{b.p75.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[10px] text-muted-foreground">
                Nightly equivalents (stay total ÷ nights) from tracked competitor listings.
              </p>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent pricing decisions
          </div>
          {history.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No history yet — run the pricing pass to see decisions land here.
            </p>
          ) : (
            <ul className="space-y-2">
              {history.slice(0, 8).map((h) => {
                const unit = units.find((u) => u.id === h.unitId);
                return (
                  <li
                    key={h.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                  >
                    <Badge variant={STATUS_VARIANT[h.status]}>{STATUS_LABEL[h.status]}</Badge>
                    <span className="text-xs font-medium">
                      {unit?.name ?? h.unitId}
                    </span>
                    <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1 font-mono">
                      ₪{h.oldRate} <ArrowRight className="h-3 w-3" /> ₪{h.newRate}
                    </span>
                    <span
                      className={cn(
                        "text-[11px] font-medium",
                        h.deltaPct >= 0
                          ? "text-[hsl(var(--success))]"
                          : "text-[hsl(var(--danger))]",
                      )}
                    >
                      {h.deltaPct >= 0 ? "+" : ""}
                      {h.deltaPct.toFixed(1)}%
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {formatRelative(h.ts)}
                    </span>
                    <p className="basis-full text-[11px] text-muted-foreground leading-snug">
                      {h.reason}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
