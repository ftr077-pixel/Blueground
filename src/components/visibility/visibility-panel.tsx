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
import {
  applyLos,
  economics,
  fmtPct,
  recommend,
  snapStayPrice,
  type CostDefaults,
  type PricingRules,
  type Rec,
} from "@/lib/revenue";

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
  address: string | null;
  monthlyRent: number | null;
  utilities: number | null;
  cleaningFee: number | null;
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

// Sort order for the Rec column: most actionable + most urgent first.
function recRank(rec: Rec) {
  if (rec.action === "hold") return 100;
  if (rec.action === "none") return 200;
  const urg = rec.urgency === "now" ? 0 : rec.urgency === "soon" ? 1 : 2;
  const act = rec.action === "lower" ? 0 : rec.action === "raise" ? 1 : 2;
  return urg * 3 + act;
}

export function VisibilityPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanRunning, setScanRunning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [primaryStay, setPrimaryStay] = useState(30);
  const [showAllStays, setShowAllStays] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "primary", dir: 1 });
  const [cost, setCost] = useState<CostDefaults>({
    bgFeePct: 6,
    airbnbFeePct: 0,
    defaultUtilities: 1000,
    defaultCleaning: 500,
    weeklyDiscountPct: 0,
    biWeeklyDiscountPct: 0,
    monthlyDiscountPct: 0,
  });
  const [rules, setRules] = useState<PricingRules>({
    marginLow: 25,
    marginHigh: 45,
    rankWellPage: 1,
    buriedPage: 5,
    urgentDays: 14,
    relaxedDays: 45,
    stepPct: 5,
    floorMargin: 10,
  });
  const [recFilter, setRecFilter] = useState("all");

  async function refresh() {
    try {
      const res = await fetch("/api/visibility", { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const body = (await res.json()) as {
        profiles: Profile[];
        listings: Listing[];
        primaryStay?: number;
        costDefaults?: Partial<CostDefaults>;
        pricingRules?: Partial<PricingRules>;
      };
      setProfiles(body.profiles);
      setListings(body.listings);
      if (body.primaryStay) setPrimaryStay(body.primaryStay);
      if (body.costDefaults) setCost((c) => ({ ...c, ...body.costDefaults }));
      if (body.pricingRules) setRules((rr) => ({ ...rr, ...body.pricingRules }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadScanState(): Promise<boolean> {
    try {
      const res = await fetch("/api/visibility/scan", { cache: "no-store" });
      const s = (await res.json()) as {
        running: boolean;
        message: string | null;
        logTail?: string;
      };
      setScanRunning(s.running);
      setScanMsg(s.message);
      setScanLog(s.logTail || "");
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

  async function cancelScan() {
    setScanMsg("stopping…");
    try {
      await fetch("/api/visibility/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancel: true }),
      });
    } catch {
      /* ignore */
    }
    await loadScanState();
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

  function recMatches(rec: Rec) {
    switch (recFilter) {
      case "raise":
        return rec.action === "raise";
      case "lower":
        return rec.action === "lower";
      case "review":
        return rec.action === "review";
      case "actionable":
        return rec.action === "raise" || rec.action === "lower" || rec.action === "review";
      case "urgent":
        return rec.urgency === "now" && rec.action !== "hold" && rec.action !== "none";
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
          {scanRunning && (
            <button
              type="button"
              onClick={cancelScan}
              className="inline-flex items-center rounded-md border border-[hsl(var(--danger))]/40 px-3 py-1.5 text-xs font-medium text-[hsl(var(--danger))] hover:bg-[hsl(var(--danger))]/10"
            >
              Stop
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
      {scanRunning && scanLog && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground">
          {scanLog}
        </pre>
      )}
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
  const ecos = listings.map((l) => economics(l, cost));
  const total = listings.length;
  const available = pcells.filter((c) => c.kind === "ranked" || c.kind === "buried").length;
  const page1 = pcells.filter((c) => c.kind === "ranked" && c.page === 1).length;
  const totRevenue = ecos.reduce((s, e) => s + (e.revenue ?? 0), 0);
  const totProfit = ecos.reduce((s, e) => s + (e.profit ?? 0), 0);
  const knownRev = ecos.filter((e) => e.profit != null).reduce((s, e) => s + (e.revenue ?? 0), 0);
  const avgMargin = knownRev ? totProfit / knownRev : null;
  const recs = listings.map((l) => recommend(l, cost, rules, primaryStay));
  const toRaise = recs.filter((r) => r.action === "raise").length;
  const toLower = recs.filter((r) => r.action === "lower").length;
  const urgentCount = recs.filter(
    (r) =>
      r.urgency === "now" && (r.action === "raise" || r.action === "lower" || r.action === "review"),
  ).length;
  const stat = (label: string, value: number | string, tone = "text-foreground") => (
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
          {stat(`Page 1 · ${primaryLabel}`, page1, "text-primary")}
          {stat("Monthly revenue", money(totRevenue))}
          {stat(
            "Monthly profit",
            money(totProfit),
            totProfit >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]",
          )}
          {stat("Avg margin", fmtPct(avgMargin))}
          {stat("▲ Raise", toRaise, "text-[hsl(var(--success))]")}
          {stat("▼ Lower", toLower, "text-[hsl(var(--danger))]")}
          {stat("Urgent", urgentCount, "text-[hsl(var(--warning))]")}
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
        <select
          className={inputCls}
          value={recFilter}
          onChange={(e) => setRecFilter(e.target.value)}
        >
          <option value="all">All recs</option>
          <option value="actionable">Needs action</option>
          <option value="raise">▲ Raise</option>
          <option value="lower">▼ Lower</option>
          <option value="review">⚠ Review</option>
          <option value="urgent">Urgent</option>
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
            e: economics(l, cost),
            rec: recommend(l, cost, rules, primaryStay),
          }))
          .filter(({ l, pc, rec }) => matches(l, pc) && recMatches(rec))
          .sort((a, b) => {
            const { key, dir } = sort;
            let d = 0;
            if (key === "name") d = a.l.label.localeCompare(b.l.label);
            else if (key === "checkin") d = cmpStr(a.h.checkIn, b.h.checkIn);
            else if (key === "revenue") d = cmpNum(a.e.revenue, b.e.revenue);
            else if (key === "rent") d = cmpNum(a.e.rent, b.e.rent);
            else if (key === "profit") d = cmpNum(a.e.profit, b.e.profit);
            else if (key === "margin") d = cmpNum(a.e.margin, b.e.margin);
            else if (key === "rec") d = recRank(a.rec) - recRank(b.rec);
            else if (key.startsWith("stay:"))
              d =
                cellRank(stayCell(a.l.latest, key.slice(5))) -
                cellRank(stayCell(b.l.latest, key.slice(5)));
            else d = cellRank(a.pc) - cellRank(b.pc);
            if (d === 0) d = a.l.label.localeCompare(b.l.label);
            return d * dir;
          });
        const colSpan = stayCols.length + 9;
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
                        onClick={() => onSort("revenue")}
                      >
                        Revenue{arrow("revenue")}
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground"
                        onClick={() => onSort("rent")}
                      >
                        Rent{arrow("rent")}
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground"
                        onClick={() => onSort("profit")}
                      >
                        Profit{arrow("profit")}
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground"
                        onClick={() => onSort("margin")}
                      >
                        Margin{arrow("margin")}
                      </th>
                      <th
                        className="cursor-pointer select-none px-3 py-2 text-left hover:text-foreground"
                        onClick={() => onSort("rec")}
                      >
                        Rec{arrow("rec")}
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
                      rows.map(({ l, h, e, rec }) => (
                        <ListingRows
                          key={l.id}
                          l={l}
                          h={h}
                          e={e}
                          rec={rec}
                          stayCols={stayCols}
                          colSpan={colSpan}
                          cost={cost}
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

function RecCell({ rec }: { rec: Rec }) {
  if (rec.action === "none")
    return (
      <span className="text-[11px] text-muted-foreground/60" title={rec.reason}>
        —
      </span>
    );
  const meta: Record<string, { label: string; cls: string }> = {
    raise: { label: "▲ Raise", cls: "text-[hsl(var(--success))]" },
    lower: { label: "▼ Lower", cls: "text-[hsl(var(--danger))]" },
    review: { label: "⚠ Review", cls: "text-[hsl(var(--warning))]" },
    hold: { label: "✓ Hold", cls: "text-muted-foreground" },
  };
  const m = meta[rec.action];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${m.cls}`}
      title={rec.reason}
    >
      {rec.urgency === "now" && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--danger))]"
          title="available soon — act now"
        />
      )}
      {m.label}
      {rec.suggested != null && (
        <span className="font-normal text-muted-foreground">→ {money(rec.suggested)}</span>
      )}
    </span>
  );
}

function ListingRows({
  l,
  h,
  e,
  rec,
  stayCols,
  colSpan,
  cost,
  isOpen,
  onToggle,
  selected,
  onSelect,
}: {
  l: Listing;
  h: ReturnType<typeof headline>;
  e: ReturnType<typeof economics>;
  rec: Rec;
  stayCols: string[];
  colSpan: number;
  cost: CostDefaults;
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
          {l.address && <div className="text-[10px] text-muted-foreground">{l.address}</div>}
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
        <td className="px-3 py-2 text-right font-mono">{money(e.revenue)}</td>
        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
          {e.rentKnown ? money(e.rent) : <span className="italic">set rent</span>}
        </td>
        <td
          className={`px-3 py-2 text-right font-mono ${
            e.profit == null
              ? "text-muted-foreground"
              : e.profit >= 0
                ? "text-[hsl(var(--success))]"
                : "text-[hsl(var(--danger))]"
          }`}
          title={`BG fee ${money(e.bgFee)} · Airbnb fee ${money(e.airbnbFee)} · utilities ${money(
            e.utilities,
          )} · cleaning ${money(e.cleaning)}`}
        >
          {money(e.profit)}
          {!e.rentKnown && e.profit != null && <span title="rent not set">*</span>}
        </td>
        <td className="px-3 py-2 text-right font-mono">{fmtPct(e.margin)}</td>
        <td className="whitespace-nowrap px-3 py-2">
          <RecCell rec={rec} />
        </td>
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
                      <td className="px-2 py-1 text-right font-mono">
                        {money(applyLos(snapStayPrice(s), s.nights, cost))}
                      </td>
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
