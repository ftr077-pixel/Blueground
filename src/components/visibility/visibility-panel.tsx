"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";

interface Snapshot {
  id: string;
  stayLabel: string;
  checkIn: string;
  eligible: boolean;
  available: boolean | null;
  found: boolean;
  page: number | null;
  position: number | null;
  rank: number | null;
  total: number | null;
  price: number | null;
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
  guests: number | null;
  minNights: number | null;
  active: boolean;
  latest: Snapshot[];
}

type State = "ranked" | "buried" | "booked" | "minstay" | "unknown" | "none";

function listingView(latest: Snapshot[]) {
  const eligible = latest.filter((s) => s.eligible);
  const found = latest.filter((s) => s.found && s.page != null);
  const availTrue = latest.filter((s) => s.available === true || s.found);
  const bestPage = found.length ? Math.min(...found.map((s) => s.page as number)) : null;
  const price =
    found.find((s) => s.price != null)?.price ??
    latest.find((s) => s.price != null)?.price ??
    null;
  let state: State;
  if (!latest.length) state = "none";
  else if (!eligible.length) state = "minstay";
  else if (found.length) state = "ranked";
  else if (availTrue.length) state = "buried";
  else if (eligible.some((s) => s.available === false)) state = "booked";
  else state = "unknown";
  return { state, bestPage, price, available: availTrue.length > 0 };
}

const STATE_ORDER: Record<State, number> = {
  ranked: 0,
  buried: 1,
  booked: 2,
  unknown: 3,
  minstay: 4,
  none: 5,
};

function money(n: number | null) {
  return n != null ? `₪${Math.round(n).toLocaleString()}` : "—";
}

export function VisibilityPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    if (!scanRunning) return;
    const t = setInterval(async () => {
      const still = await loadScanState();
      if (!still) {
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
      setScanMsg("scanning… this can take a few minutes for a big portfolio");
    } catch {
      setScanMsg("could not start scan");
    }
  }

  function toggle(id: string) {
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
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
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50"
        >
          <Settings className="h-3.5 w-3.5" /> Manage
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
            profile and your listings, then hit <span className="text-foreground">Run scan now</span>.
          </CardContent>
        </Card>
      </div>
    );
  }

  // portfolio summary
  const views = listings.map((l) => listingView(l.latest));
  const total = listings.length;
  const available = views.filter((v) => v.state === "ranked" || v.state === "buried").length;
  const inSearch = views.filter((v) => v.state === "ranked").length;
  const page1 = views.filter((v) => v.bestPage === 1).length;

  const stat = (label: string, value: number, tone = "text-foreground") => (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      {topBar}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          {stat("Listings", total)}
          {stat("Available", available, "text-[hsl(var(--success))]")}
          {stat("Appearing in search", inSearch, "text-primary")}
          {stat("On page 1", page1, "text-[hsl(var(--success))]")}
          <p className="ml-auto max-w-xs text-[11px] text-muted-foreground">
            “Available but not in search” are your price-experiment targets — bookable, just ranked
            past the cap.
          </p>
        </CardContent>
      </Card>

      {profiles.map((p) => {
        const rows = listings
          .filter((l) => l.profileId === p.id)
          .map((l) => ({ l, v: listingView(l.latest) }))
          .sort((a, b) => {
            const d = STATE_ORDER[a.v.state] - STATE_ORDER[b.v.state];
            if (d !== 0) return d;
            return (a.v.bestPage ?? 999) - (b.v.bestPage ?? 999);
          });
        if (rows.length === 0) return null;
        return (
          <Card key={p.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  <Radar className="h-4 w-4 text-primary" />
                  {p.label}
                </CardTitle>
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
                      <th className="px-3 py-2 text-left">Available?</th>
                      <th className="px-3 py-2 text-left">Position</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ l, v }) => {
                      const isOpen = open.has(l.id);
                      return (
                        <ListingRows key={l.id} l={l} v={v} isOpen={isOpen} onToggle={() => toggle(l.id)} />
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

function AvailBadge({ state }: { state: State }) {
  if (state === "ranked" || state === "buried") return <Badge variant="success">Available</Badge>;
  if (state === "booked") return <Badge variant="muted">Booked</Badge>;
  if (state === "minstay") return <Badge variant="muted">Min-stay</Badge>;
  if (state === "none") return <span className="text-[11px] text-muted-foreground">not scanned</span>;
  return <span className="text-[11px] text-muted-foreground">unknown</span>;
}

function PositionCell({ state, bestPage }: { state: State; bestPage: number | null }) {
  if (state === "ranked")
    return <Badge variant="success">page {bestPage}</Badge>;
  if (state === "buried")
    return <span className="text-[11px] text-[hsl(var(--warning))]">not in top 280</span>;
  return <span className="text-[11px] text-muted-foreground">—</span>;
}

function ListingRows({
  l,
  v,
  isOpen,
  onToggle,
}: {
  l: Listing;
  v: ReturnType<typeof listingView>;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="border-t border-border/60 cursor-pointer hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="font-medium">{l.label}</div>
          <div className="text-[10px] text-muted-foreground">
            {l.airbnbId}
            {l.guests != null && ` · ${l.guests} guests`}
          </div>
        </td>
        <td className="px-3 py-2">
          <AvailBadge state={v.state} />
        </td>
        <td className="px-3 py-2">
          <PositionCell state={v.state} bestPage={v.bestPage} />
        </td>
        <td className="px-3 py-2 text-right font-mono">{money(v.price)}</td>
        <td className="px-2 py-2 text-muted-foreground">
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-border/40 bg-background/40">
          <td colSpan={5} className="px-3 py-2">
            {l.latest.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No scan data yet.</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Check-in</th>
                    <th className="px-2 py-1 text-left">Stay</th>
                    <th className="px-2 py-1 text-left">Available</th>
                    <th className="px-2 py-1 text-left">Position</th>
                    <th className="px-2 py-1 text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {l.latest.map((s) => (
                    <tr key={s.id} className="border-t border-border/40">
                      <td className="px-2 py-1 font-mono text-muted-foreground">{s.checkIn}</td>
                      <td className="px-2 py-1">{s.stayLabel}</td>
                      <td className="px-2 py-1">
                        {!s.eligible
                          ? "min-stay"
                          : s.available === true || s.found
                            ? "yes"
                            : s.available === false
                              ? "booked"
                              : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {s.found && s.page != null
                          ? `page ${s.page} · pos ${s.position} (${s.rank}/${s.total})`
                          : s.eligible && (s.available === true)
                            ? "not in top 280"
                            : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{money(s.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
