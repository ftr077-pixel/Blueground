"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Play, Radar, RefreshCw, Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";

interface Snapshot {
  id: string;
  stayLabel: string;
  checkIn: string;
  eligible: boolean;
  found: boolean;
  page: number | null;
  rank: number | null;
  total: number | null;
}

interface Profile {
  id: string;
  label: string;
  guests: number;
  currency: string;
  active: boolean;
  lastRunAt: string | null;
}

interface Listing {
  id: string;
  airbnbId: string;
  label: string;
  profileId: string;
  minNights: number | null;
  active: boolean;
  latest: Snapshot[];
}

function summarize(latest: Snapshot[]) {
  const stays = Array.from(new Set(latest.map((s) => s.stayLabel)));
  const eligible = stays.filter((l) => latest.some((s) => s.stayLabel === l && s.eligible));
  const found = latest.filter((s) => s.eligible && s.found && s.page != null);
  const bestPage = found.length ? Math.min(...found.map((s) => s.page as number)) : null;
  return {
    scanned: latest.length > 0,
    stays: stays.length,
    eligible: eligible.length,
    bestPage,
    anyEligible: eligible.length > 0,
  };
}

export function VisibilityPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/visibility", { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as { profiles: Profile[]; listings: Listing[] };
      setProfiles(body.profiles);
      setListings(body.listings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadScanState(): Promise<boolean> {
    try {
      const res = await fetch("/api/visibility/scan", { cache: "no-store" });
      const s = (await res.json()) as { running: boolean; message: string | null };
      setScanRunning(s.running);
      setScanMsg(s.message);
      return s.running;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    refresh();
    loadScanState();
  }, []);

  // While a scan is running, poll until it finishes, then refresh the data.
  useEffect(() => {
    if (!scanRunning) return;
    const t = setInterval(async () => {
      const stillRunning = await loadScanState();
      if (!stillRunning) {
        clearInterval(t);
        refresh();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [scanRunning]);

  async function runScan() {
    setScanMsg(null);
    try {
      const res = await fetch("/api/visibility/scan", { method: "POST" });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setScanMsg(e.error || `could not start scan (${res.status})`);
        return;
      }
      setScanRunning(true);
      setScanMsg("scanning… this takes a few minutes");
    } catch {
      setScanMsg("could not start scan");
    }
  }

  const topBar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={runScan}
          disabled={scanRunning}
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-60"
        >
          {scanRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {scanRunning ? "Scanning…" : "Run scan now"}
        </button>
        <Link
          href="/visibility/manage"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50"
        >
          <Settings className="h-3.5 w-3.5" /> Manage listings &amp; searches
        </Link>
      </div>
      {scanMsg && <p className="text-[11px] text-muted-foreground">{scanMsg}</p>}
    </div>
  );

  if (loading) return <p className="text-xs text-muted-foreground">Loading visibility…</p>;
  if (error) return <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>;

  if (listings.length === 0) {
    return (
      <div className="space-y-4">
        {topBar}
        <Card>
          <CardContent className="p-5 text-xs text-muted-foreground">
            No listings tracked yet. Open <span className="text-foreground">Manage</span> to add a
            search profile and your listings, then hit <span className="text-foreground">Run scan
            now</span>.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {topBar}
      {profiles.map((p) => {
        const rows = listings.filter((l) => l.profileId === p.id);
        if (rows.length === 0) return null;
        return (
          <Card key={p.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Radar className="h-4 w-4 text-primary" />
                    {p.label}
                  </CardTitle>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {p.guests} guests · {p.currency} · {rows.length} listing
                    {rows.length === 1 ? "" : "s"}
                    {!p.active && " · paused"}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <RefreshCw className="h-3 w-3" />
                  {p.lastRunAt ? `scanned ${formatRelative(p.lastRunAt)}` : "never scanned"}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Listing</th>
                      <th className="px-3 py-2 text-right">Min stay</th>
                      <th className="px-3 py-2 text-right">Eligible</th>
                      <th className="px-3 py-2 text-left">Best result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l) => {
                      const s = summarize(l.latest);
                      return (
                        <tr key={l.id} className="border-t border-border/60">
                          <td className="px-3 py-2">
                            <div className="font-medium">{l.label}</div>
                            <div className="text-[10px] text-muted-foreground">{l.airbnbId}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {l.minNights != null ? `${l.minNights}n` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {s.scanned ? `${s.eligible}/${s.stays}` : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {!s.scanned ? (
                              <span className="text-[11px] text-muted-foreground">not scanned</span>
                            ) : s.bestPage != null ? (
                              <Badge variant="success">page {s.bestPage}</Badge>
                            ) : s.anyEligible ? (
                              <Badge variant="warning">beyond cap</Badge>
                            ) : (
                              <Badge variant="muted">ineligible</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
