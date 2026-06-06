"use client";

import { useEffect, useState } from "react";
import { Radar, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";

interface Snapshot {
  id: string;
  stayLabel: string;
  nights: number;
  checkIn: string;
  checkOut: string;
  eligible: boolean;
  minNights: number | null;
  found: boolean;
  page: number | null;
  position: number | null;
  rank: number | null;
  total: number | null;
  price: number | null;
  currency: string | null;
}

interface SearchDto {
  id: string;
  listingId: string;
  label: string;
  platform: string;
  guests: number;
  currency: string;
  minNights: number | null;
  lastRunAt: string | null;
  latest: Snapshot[];
}

function pageScore(page: number | null): number {
  if (page == null) return 0;
  return Math.max(0, 100 - (page - 1) * 15);
}

function computeIndex(latest: Snapshot[]) {
  const stayLabels = Array.from(new Set(latest.map((s) => s.stayLabel)));
  const eligibleLabels = stayLabels.filter((l) =>
    latest.some((s) => s.stayLabel === l && s.eligible),
  );
  const coveragePct = stayLabels.length
    ? (eligibleLabels.length / stayLabels.length) * 100
    : 0;
  const eligibleSnaps = latest.filter((s) => s.eligible);
  const scores = eligibleSnaps.map((s) => (s.found ? pageScore(s.page) : 0));
  const rankScore = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : null;
  const blocked = stayLabels.filter((l) => !eligibleLabels.includes(l));
  return { coveragePct, eligibleLabels, stayLabels, rankScore, blocked };
}

export function VisibilityPanel() {
  const [searches, setSearches] = useState<SearchDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const res = await fetch("/api/visibility", { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as { searches: SearchDto[] };
      setSearches(body.searches);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading visibility…</p>;
  }
  if (error) {
    return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;
  }
  if (searches.length === 0) {
    return (
      <Card>
        <CardContent className="p-5 text-xs text-muted-foreground">
          No tracked searches yet. Add one and the scanner box will start filling in rank history.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {searches.map((s) => {
        const idx = computeIndex(s.latest);
        return (
          <Card key={s.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Radar className="h-4 w-4 text-primary" />
                    {s.label}
                  </CardTitle>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {s.platform} · listing {s.listingId} · {s.guests} guests · {s.currency}
                    {s.minNights != null && <> · min stay {s.minNights}n</>}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <RefreshCw className="h-3 w-3" />
                  {s.lastRunAt ? `scanned ${formatRelative(s.lastRunAt)}` : "never scanned"}
                </span>
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-background/40 p-4">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Eligibility coverage
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight">
                      {idx.eligibleLabels.length}/{idx.stayLabels.length}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      stay lengths ({idx.coveragePct.toFixed(0)}%)
                    </span>
                  </div>
                  {idx.blocked.length > 0 && (
                    <p className="mt-1 text-[11px] text-[hsl(var(--warning))]">
                      invisible for {idx.blocked.join(", ")} — min-stay filter
                    </p>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-background/40 p-4">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Rank score · where eligible
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight">
                      {idx.rankScore == null ? "—" : `${idx.rankScore.toFixed(0)}/100`}
                    </span>
                    <span className="text-[11px] text-muted-foreground">page 1 = 100</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Latest scan · {s.latest.length} windows
                </div>
                {s.latest.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No scan yet — the box will post results here on its next run.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left">Stay</th>
                          <th className="px-3 py-2 text-left">Check-in</th>
                          <th className="px-3 py-2 text-left">Status</th>
                          <th className="px-3 py-2 text-right">Page</th>
                          <th className="px-3 py-2 text-right">Pos</th>
                          <th className="px-3 py-2 text-right">Rank</th>
                          <th className="px-3 py-2 text-right">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.latest.map((snap) => (
                          <tr key={snap.id} className="border-t border-border/60">
                            <td className="px-3 py-2 font-medium">{snap.stayLabel}</td>
                            <td className="px-3 py-2 font-mono text-muted-foreground">
                              {snap.checkIn}
                            </td>
                            <td className="px-3 py-2">
                              {!snap.eligible ? (
                                <Badge variant="muted">Ineligible</Badge>
                              ) : snap.found ? (
                                <Badge variant="success">On page {snap.page}</Badge>
                              ) : (
                                <Badge variant="warning">
                                  Beyond top {snap.total ?? "?"}
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{snap.page ?? "—"}</td>
                            <td className="px-3 py-2 text-right font-mono">
                              {snap.position ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {snap.rank != null ? `${snap.rank}/${snap.total ?? "?"}` : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {snap.price != null ? `₪${snap.price.toLocaleString()}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
