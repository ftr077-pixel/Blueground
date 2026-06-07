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
  ts: string;
  stayLabel: string;
  nights: number;
  checkIn: string;
  eligible: boolean;
  available: boolean | null;
  minNights: number | null;
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
  stayNights: number[];
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

const STAY_LABELS: Record<number, string> = {
  7: "1 week",
  14: "2 weeks",
  30: "1 month",
  60: "2 months",
  90: "3 months",
};
const nightsLabel = (n: number) => STAY_LABELS[n] ?? `${n} nights`;

// Best result for one listing at one stay length (across its dates).
function stayCell(latest: Snapshot[], label: string) {
  const rows = latest.filter((s) => s.stayLabel === label);
  if (!rows.length) return { kind: "none" as const };
  const found = rows.filter((s) => s.found && s.page != null);
  if (found.length) {
    const best = found.reduce((b, r) => ((r.page as number) < (b.page as number) ? r : b));
    return { kind: "ranked" as const, page: best.page, rank: best.rank, total: best.total };
  }
  if (rows.some((s) => s.eligible && s.available === true)) return { kind: "buried" as const };
  if (rows.some((s) => !s.eligible)) {
    return { kind: "minstay" as const, min: rows.find((s) => !s.eligible)?.minNights ?? null };
  }
  if (rows.some((s) => s.available === false)) return { kind: "booked" as const };
  return { kind: "unknown" as const };
}

function money(n: number | null) {
  return n != null ? `₪${Math.round(n).toLocaleString()}` : "—";
}

// The check-in (first available) date + matching price for the row's headline.
// Prefers the primary (monthly) stay's best-ranked result, falling back to the
// earliest dated snapshot, then to any stay length.
function headline(latest: Snapshot[], primaryLabel: string) {
  const pickFrom = (rows: Snapshot[]) => {
    const found = rows.filter((s): s is Snapshot & { page: number } => s.found && s.page != null);
    if (found.length) return found.reduce((b, s) => (s.page < b.page ? s : b));
    const dated = rows.filter((s) => s.checkIn);
    return dated.length ? dated.reduce((b, s) => (s.checkIn < b.checkIn ? s : b)) : null;
  };
  const s = pickFrom(latest.filter((r) => r.stayLabel === primaryLabel)) ?? pickFrom(latest);
  return { checkIn: s?.checkIn ?? null, price: s?.price ?? null };
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function cellRank(c: ReturnType<typeof stayCell>) {
  if (c.kind === "ranked") return c.page ?? 99;
  if (c.kind === "buried") return 1000;
  if (c.kind === "booked") return 2000;
  if (c.kind === "minstay") return 3000;
  return 4000;
}

// Comparators with nulls sorted last (under ascending).
function cmpNum(a: number | null, b: number | null) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}
function cmpStr(a: string | null, b: string | null) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function VisibilityPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [primaryStay, setPrimaryStay] = useState(30);
  const [showAllStays, setShowAllStays] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "primary", dir: 1 });

  async function refresh() {
    try {
      const res = await fetch("/api/visibility", { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as {
        profiles: Profile[];
        listings: Listing[];
        primaryStay?: number;
      };
      setProfiles(body.profiles);
      setListings(body.listings);
      if (body.primaryStay) setPrimaryStay(body.primaryStay);
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
      const res = await fetch("/api/visibility/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds: selected.size ? Array.from(selected) : [] }),
      });
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
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleSelect(id: string) {
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function matches(l: Listing, cell: ReturnType<typeof stayCell>) {
    if (q && !`${l.label} ${l.airbnbId}`.toLowerCase().includes(q.toLowerCase())) return false;
    switch (statusFilter) {
      case "page1":
        return cell.kind === "ranked" && cell.page === 1;
      case "insearch":
        return cell.kind === "ranked";
      case "buried":
        return cell.kind === "buried";
      case "booked":
        return cell.kind === "booked";
      case "minstay":
        return cell.kind === "minstay";
      default:
        return true;
    }
  }

  // Click a header to sort by it; click again to flip direction.
  function onSort(key: string) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");

  const topBar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
            {scanRunning
              ? "Scanning…"
              : selected.size
                ? `Run scan · ${selected.size} selected`
                : "Run scan · all"}
          </button>
          {selected.size > 0 && !scanRunning && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/visibility/manage"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50"
          >
            <Settings className="h-3.5 w-3.5" /> Manage
          </Link>
        </div>
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
            profile and your listings, then hit <span className="text-foreground">Run scan</span>.
          </CardContent>
        </Card>
      </div>
    );
  }

  const primaryLabel = nightsLabel(primaryStay);
  const pcells = listings.map((l) => stayCell(l.latest, primaryLabel));
  const total = listings.length;
  const available = pcells.filter((c) => c.kind === "ranked" || c.kind === "buried").length;
  const inSearch = pcells.filter((c) => c.kind === "ranked").length;
  const page1 = pcells.filter((c) => c.kind === "ranked" && c.page === 1).length;
  const stat = (label: string, value: number, tone = "text-foreground") => (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );

  const inputCls =
    "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";

  return (
    <div className="space-y-6">
      {topBar}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-3 p-5">
          {stat("Listings", total)}
          {stat(`Available · ${primaryLabel}`, available, "text-[hsl(var(--success))]")}
          {stat(`In search · ${primaryLabel}`, inSearch, "text-primary")}
          {stat(`Page 1 · ${primaryLabel}`, page1, "text-[hsl(var(--success))]")}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} w-64`}
          placeholder="Filter by name or Airbnb ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className={inputCls}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="page1">On page 1</option>
          <option value="insearch">In search</option>
          <option value="buried">Available · not ranked</option>
          <option value="booked">Booked</option>
          <option value="minstay">Min-stay only</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showAllStays}
            onChange={(e) => setShowAllStays(e.target.checked)}
          />
          Show all stay lengths
        </label>
      </div>

      {profiles.map((p) => {
        const allCols = [...(p.stayNights ?? [])].sort((a, b) => a - b).map(nightsLabel);
        // Default to just the primary (monthly) column; the row's expander still
        // shows every stay length. Fall back to all if this profile lacks it.
        const stayCols =
          showAllStays || !allCols.includes(primaryLabel) ? allCols : [primaryLabel];
        const rows = listings
          .filter((l) => l.profileId === p.id)
          .map((l) => ({
            l,
            pc: stayCell(l.latest, primaryLabel),
            h: headline(l.latest, primaryLabel),
          }))
          .filter(({ l, pc }) => matches(l, pc))
          .sort((a, b) => {
            const { key, dir } = sort;
            let d = 0;
            if (key === "name") d = a.l.label.localeCompare(b.l.label);
            else if (key === "checkin") d = cmpStr(a.h.checkIn, b.h.checkIn);
            else if (key === "price") d = cmpNum(a.h.price, b.h.price);
            else if (key.startsWith("stay:"))
              d =
                cellRank(stayCell(a.l.latest, key.slice(5))) -
                cellRank(stayCell(b.l.latest, key.slice(5)));
            else d = cellRank(a.pc) - cellRank(b.pc);
            if (d === 0) d = a.l.label.localeCompare(b.l.label);
            return d * dir;
          });
        const colSpan = stayCols.length + 5;
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
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2" />
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-left hover:text-foreground"
                        onClick={() => onSort("name")}
                      >
                        Listing{arrow("name")}
                      </th>
                      {stayCols.map((c) => {
                        const key = `stay:${c}`;
                        const isPrimary = c === primaryLabel;
                        const active = sort.key === key || (isPrimary && sort.key === "primary");
                        return (
                          <th
                            key={c}
                            onClick={() => onSort(key)}
                            className={`cursor-pointer select-none px-3 py-2 text-center hover:text-foreground ${
                              isPrimary ? "font-semibold text-foreground" : ""
                            }`}
                          >
                            {isPrimary ? `★ ${c}` : c}
                            {active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                          </th>
                        );
                      })}
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-left hover:text-foreground"
                        onClick={() => onSort("checkin")}
                      >
                        Check-in{arrow("checkin")}
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground"
                        onClick={() => onSort("price")}
                      >
                        Price{arrow("price")}
                      </th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={colSpan} className="px-3 py-3 text-[11px] text-muted-foreground">
                          No listings match the filter.
                        </td>
                      </tr>
                    ) : (
                      rows.map(({ l, h }) => (
                        <ListingRows
                          key={l.id}
                          l={l}
                          h={h}
                          stayCols={stayCols}
                          colSpan={colSpan}
                          isOpen={open.has(l.id)}
                          onToggle={() => toggle(l.id)}
                          selected={selected.has(l.id)}
                          onSelect={() => toggleSelect(l.id)}
                        />
                      ))
                    )}
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

function StayCell({ cell }: { cell: ReturnType<typeof stayCell> }) {
  if (cell.kind === "ranked")
    return (
      <span
        className="font-semibold text-[hsl(var(--success))]"
        title={`rank ${cell.rank}/${cell.total}`}
      >
        p{cell.page}
      </span>
    );
  if (cell.kind === "buried")
    return <span className="text-[hsl(var(--warning))]" title="available, ranked beyond ~280">&gt;280</span>;
  if (cell.kind === "minstay")
    return (
      <span className="text-muted-foreground" title={cell.min ? `min stay ${cell.min}n` : "min-stay"}>
        min{cell.min ? ` ${cell.min}` : ""}
      </span>
    );
  if (cell.kind === "booked") return <span className="text-muted-foreground">booked</span>;
  return <span className="text-muted-foreground/50">·</span>;
}

function ListingRows({
  l,
  h,
  stayCols,
  colSpan,
  isOpen,
  onToggle,
  selected,
  onSelect,
}: {
  l: Listing;
  h: ReturnType<typeof headline>;
  stayCols: string[];
  colSpan: number;
  isOpen: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <>
      <tr className="border-t border-border/60 cursor-pointer hover:bg-muted/30" onClick={onToggle}>
        <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`select ${l.label}`} />
        </td>
        <td className="px-3 py-2">
          <Link
            href={`/visibility/listing/${l.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium hover:text-primary"
          >
            {l.label}
          </Link>
          <div className="text-[10px] text-muted-foreground">
            {l.airbnbId}
            {l.guests != null && ` · ${l.guests} guests`}
          </div>
        </td>
        {stayCols.map((c) => (
          <td key={c} className="px-3 py-2 text-center font-mono">
            <StayCell cell={stayCell(l.latest, c)} />
          </td>
        ))}
        <td
          className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground"
          title={h.checkIn ?? ""}
        >
          {fmtDate(h.checkIn)}
        </td>
        <td className="px-3 py-2 text-right font-mono">{money(h.price)}</td>
        <td className="px-2 py-2 text-muted-foreground">
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-border/40 bg-background/40">
          <td colSpan={colSpan} className="px-3 py-2">
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
                      <td className="px-2 py-1 font-mono text-muted-foreground">{s.checkIn || "—"}</td>
                      <td className="px-2 py-1">{s.stayLabel}</td>
                      <td className="px-2 py-1">
                        {!s.eligible
                          ? s.minNights != null
                            ? `min-stay ${s.minNights}n`
                            : "min-stay"
                          : s.available === true || s.found
                            ? "yes"
                            : s.available === false
                              ? "booked"
                              : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {s.found && s.page != null
                          ? `page ${s.page} · pos ${s.position} (${s.rank}/${s.total})`
                          : s.eligible && s.available === true
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
