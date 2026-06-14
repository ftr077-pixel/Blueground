"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CHART, fmtMoney, nightsLabel } from "@/lib/revenue";

interface Snap {
  nights: number;
  checkIn: string;
  found: boolean;
}
interface Listing {
  id: string;
  label: string;
  profileId: string;
  latest: Snap[];
}

interface CurvePoint {
  nightly: number;
  expectedRank: number;
  expectedPage: number;
}
interface Elasticity {
  listingId: string;
  label: string;
  checkIn: string | null;
  nights: number;
  leadDays: number | null;
  segment: { area: string; leadBucket: string; nights: number };
  current: {
    nightly: number | null;
    rank: number | null;
    page: number | null;
    found: boolean;
    expectedPage: number | null;
  };
  target: {
    page: number;
    nightly: number | null;
    deltaNightly: number | null;
    deltaPct: number | null;
    reachable: boolean;
  } | null;
  marginal: { positionsPer100Nightly: number | null; positionsPerPct: number | null };
  revenue: { nights: number; before: number | null; after: number | null; delta: number | null };
  economics: {
    rentKnown: boolean;
    profitBefore: number | null;
    profitAfter: number | null;
    marginBefore: number | null;
    marginAfter: number | null;
  } | null;
  model: {
    offsetRank: number;
    offsetN: number;
    ownPositionsPerPct: number | null;
    ownN: number;
  };
  confidence: {
    level: "high" | "medium" | "low";
    n: number;
    ciNightlyLow: number | null;
    ciNightlyHigh: number | null;
    freshnessDays: number | null;
  };
  demand: DemandSignal | null;
  curve: CurvePoint[];
  note: string | null;
}

interface DemandComponent {
  index: number;
  percentile: number;
  raw: number;
  n: number;
}
interface DemandSignal {
  area: string;
  date: string;
  index: number | null;
  label: "hot" | "firm" | "soft" | "cold" | null;
  market: DemandComponent | null;
  supply: DemandComponent | null;
  ourOccupancy: number | null;
  readingTs: string | null;
}

const selectCls =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));

// ----------------------------------------------------------- suggestions queue
interface SuggestionRow {
  listingId: string;
  unitId: string | null;
  label: string;
  area: string;
  checkIn: string | null;
  nights: number;
  direction: "increase" | "decrease";
  currentNightly: number;
  suggestedNightly: number;
  deltaNightly: number;
  deltaPct: number;
  currentPage: number | null;
  expectedPage: number | null;
  targetPage: number;
  suggestedPage: number;
  confidence: "high" | "medium" | "low";
  n: number;
  profitAfter: number | null;
  marginAfter: number | null;
  floored: boolean;
}
interface SuggestionBatch {
  scanned: number;
  hiddenLowConfidence: number;
  appliedPending: number;
  hiddenFloorBound: number;
  suggestions: SuggestionRow[];
}

type ApplyMode = "base" | "override";

function SuggestionsQueue({
  targetPage,
  onInspect,
}: {
  targetPage: number;
  onInspect: (listingId: string) => void;
}) {
  const [batch, setBatch] = useState<SuggestionBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null); // `${listingId}:${mode}`
  const [applied, setApplied] = useState<
    Record<string, { nightly: number; mode: ApplyMode; rateUpdated: boolean }>
  >({});

  useEffect(() => {
    setLoading(true);
    fetch(`/api/learning/suggestions?targetPage=${targetPage}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((b: SuggestionBatch) => setBatch(b))
      .catch((e) => setErr(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [targetPage]);

  async function apply(row: SuggestionRow, mode: ApplyMode) {
    setApplying(`${row.listingId}:${mode}`);
    setErr(null);
    try {
      const r = await fetch("/api/learning/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId: row.listingId, nights: row.nights, targetPage, mode }),
      });
      const b = (await r.json()) as {
        ok?: boolean;
        newNightly?: number;
        rateUpdated?: boolean;
        error?: string;
      };
      if (!r.ok || !b.ok) throw new Error(b.error || `apply failed: ${r.status}`);
      setApplied((m) => ({
        ...m,
        [row.listingId]: { nightly: b.newNightly ?? row.suggestedNightly, mode, rateUpdated: !!b.rateUpdated },
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed");
    } finally {
      setApplying(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle>Suggested moves</CardTitle>
          {batch && (
            <span className="text-[11px] text-muted-foreground">
              {batch.suggestions.length} of {batch.scanned} listings have a suggested move
              {batch.hiddenLowConfidence > 0 && ` · ${batch.hiddenLowConfidence} low-confidence hidden`}
              {batch.appliedPending > 0 && ` · ${batch.appliedPending} applied, awaiting scan`}
              {batch.hiddenFloorBound > 0 && ` · ${batch.hiddenFloorBound} can’t profitably reach a better page`}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Only listings the model says are mispriced for page {targetPage} — everything else is
          already about right. <span className="text-foreground">Base rate</span> sets the unit&apos;s
          anchor (Rates Calendar, engine &amp; P&amp;L all rebuild from it);{" "}
          <span className="text-foreground">Override</span> pins the price for just this check-in&apos;s
          nights. Both log the change for outcome tracking; an unmapped listing is logged only.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-[11px] text-muted-foreground">Scanning portfolio…</p>
        ) : !batch || batch.suggestions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No actionable suggestions right now — prices look aligned with the market
            {batch && (batch.appliedPending > 0 || batch.hiddenLowConfidence > 0 || batch.hiddenFloorBound > 0)
              ? ` (${[
                  batch.appliedPending > 0 ? `${batch.appliedPending} applied, awaiting scan` : null,
                  batch.hiddenFloorBound > 0
                    ? `${batch.hiddenFloorBound} can’t reach a better page within your margin floor`
                    : null,
                  batch.hiddenLowConfidence > 0 ? `${batch.hiddenLowConfidence} still learning` : null,
                ]
                  .filter(Boolean)
                  .join("; ")}).`
              : "."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Listing</th>
                  <th className="px-3 py-2 text-left" title="Check-in (stay start) date this suggestion is computed for — the soonest scanned window">
                    Check-in
                  </th>
                  <th className="px-3 py-2 text-right">Now ₪/n</th>
                  <th className="px-3 py-2 text-right">Suggested</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2 text-right">Page</th>
                  <th
                    className="px-3 py-2 text-right"
                    title="Monthly profit if you apply this move — the same cost model as the Profit column in Search & Profit. Green = profitable, red = a loss."
                  >
                    Profit/mo
                  </th>
                  <th className="px-3 py-2 text-left">Conf.</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {batch.suggestions.map((s) => {
                  const ap = applied[s.listingId];
                  return (
                    <tr key={s.listingId} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => onInspect(s.listingId)}
                          className="max-w-[16rem] truncate text-left font-medium hover:text-primary"
                          title="Open in the inspector below"
                        >
                          {s.label}
                        </button>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{s.checkIn ?? "soonest"}</td>
                      <td className="px-3 py-2 text-right font-mono">₪{s.currentNightly}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        ₪{ap ? ap.nightly : s.suggestedNightly}
                        {s.floored && (
                          <span
                            className="ml-1 align-middle text-[9px] font-normal uppercase tracking-wide text-muted-foreground"
                            title="Capped at your margin floor — the curve pointed lower, but a deeper cut would breach the margin floor you set (which may be a deliberate loss)"
                          >
                            floor
                          </span>
                        )}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-medium",
                          s.direction === "increase"
                            ? "text-[hsl(var(--success))]"
                            : "text-[hsl(var(--danger))]",
                        )}
                      >
                        {s.direction === "increase" ? "▲ +" : "▼ "}
                        {s.deltaPct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        {s.currentPage ?? s.expectedPage ?? "—"}→{s.suggestedPage}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {s.profitAfter != null ? (
                          <span
                            className={
                              s.profitAfter >= 0
                                ? "text-[hsl(var(--success))]"
                                : "text-[hsl(var(--danger))]"
                            }
                            title={`₪${s.profitAfter.toLocaleString()}/mo if you apply this move${
                              s.marginAfter != null ? ` · ${s.marginAfter}% margin` : ""
                            }`}
                          >
                            ₪{s.profitAfter.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title="Set this listing's rent to compute profit">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {s.confidence === "high" ? (
                          <Badge variant="success">high · {s.n}</Badge>
                        ) : (
                          <Badge variant="info">med · {s.n}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {ap ? (
                          <Badge variant={ap.rateUpdated ? "success" : "muted"}>
                            {ap.rateUpdated ? `${ap.mode === "base" ? "base" : "override"} ✓` : "logged"}
                          </Badge>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => apply(s, "base")}
                              disabled={applying != null}
                              title="Set the unit's base (anchor) rate — the Rates Calendar, pricing engine, and P&L all rebuild from it (affects all dates)"
                              className="rounded-md border border-primary/30 bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                            >
                              {applying === `${s.listingId}:base` ? "…" : "Base rate"}
                            </button>
                            <button
                              type="button"
                              onClick={() => apply(s, "override")}
                              disabled={applying != null}
                              title="Pin this price for this check-in's nights as a Rates Calendar override (base rate untouched)"
                              className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
                            >
                              {applying === `${s.listingId}:override` ? "…" : "Override"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {err && <p className="mt-2 text-[11px] text-[hsl(var(--danger))]">{err}</p>}
      </CardContent>
    </Card>
  );
}

export function IntelligencePanel() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [primaryStay, setPrimaryStay] = useState(30);
  const [listingId, setListingId] = useState("");
  const [nights, setNights] = useState(30);
  const [checkIn, setCheckIn] = useState("");
  const [targetPage, setTargetPage] = useState(1);
  const [data, setData] = useState<Elasticity | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Load the portfolio once to populate the listing / stay / check-in pickers.
  useEffect(() => {
    fetch("/api/visibility", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { listings: Listing[]; primaryStay?: number }) => {
        setListings(b.listings);
        if (b.primaryStay) setPrimaryStay(b.primaryStay);
        if (b.listings.length) setListingId(b.listings[0].id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const listing = useMemo(() => listings.find((l) => l.id === listingId), [listings, listingId]);
  const stays = useMemo(
    () => (listing ? uniq(listing.latest.map((s) => s.nights)).sort((a, b) => a - b) : []),
    [listing],
  );
  const checkIns = useMemo(
    () =>
      listing
        ? uniq(listing.latest.filter((s) => s.nights === nights && s.checkIn).map((s) => s.checkIn)).sort()
        : [],
    [listing, nights],
  );

  // Keep stay/check-in valid as the listing changes.
  useEffect(() => {
    if (!listing) return;
    const s = stays.includes(primaryStay) ? primaryStay : stays[0] ?? 30;
    setNights(s);
  }, [listing, stays, primaryStay]);
  useEffect(() => {
    setCheckIn((c) => (checkIns.includes(c) ? c : checkIns[0] ?? ""));
  }, [checkIns]);

  // Fetch the recommendation whenever the selection changes. Selection changes
  // fire this twice in quick succession (listing change → stay reset), so stale
  // responses are dropped; errors clear on the next success rather than
  // replacing the whole panel (which would unmount the very selectors needed
  // to recover from e.g. a transient 500).
  useEffect(() => {
    if (!listingId) return;
    const params = new URLSearchParams({
      listingId,
      nights: String(nights),
      targetPage: String(targetPage),
    });
    if (checkIn) params.set("checkIn", checkIn);
    let stale = false;
    fetch(`/api/learning/elasticity?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`request failed (${r.status})`))))
      .then((b: Elasticity) => {
        if (stale) return;
        setData(b);
        setErr(null);
      })
      .catch((e) => {
        if (!stale) setErr(e instanceof Error ? e.message : "failed to load");
      });
    return () => {
      stale = true;
    };
  }, [listingId, nights, checkIn, targetPage]);

  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (err && !listings.length)
    return <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>;
  if (!listings.length)
    return <p className="text-[11px] text-muted-foreground">No listings tracked yet.</p>;

  const confBadge =
    data == null ? null : data.confidence.level === "high" ? (
      <Badge variant="success">high confidence</Badge>
    ) : data.confidence.level === "medium" ? (
      <Badge variant="info">medium confidence</Badge>
    ) : (
      <Badge variant="muted">learning</Badge>
    );

  return (
    <div className="space-y-6">
      <SuggestionsQueue targetPage={targetPage} onInspect={(id) => setListingId(id)} />
      <ScorecardCard />

      <div className="flex flex-wrap items-center gap-2">
        <select className={`${selectCls} max-w-[20rem]`} value={listingId} onChange={(e) => setListingId(e.target.value)}>
          {listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <select className={selectCls} value={nights} onChange={(e) => setNights(Number(e.target.value))}>
          {(stays.length ? stays : [30]).map((s) => (
            <option key={s} value={s}>
              {nightsLabel(s)}
            </option>
          ))}
        </select>
        <select className={selectCls} value={checkIn} onChange={(e) => setCheckIn(e.target.value)}>
          {checkIns.length ? (
            checkIns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))
          ) : (
            <option value="">soonest</option>
          )}
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          target
          <select
            className={selectCls}
            value={targetPage}
            onChange={(e) => setTargetPage(Number(e.target.value))}
          >
            {[1, 2, 3].map((p) => (
              <option key={p} value={p}>
                page {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {err && (
        <p className="text-[11px] text-[hsl(var(--danger))]">
          Couldn’t load the recommendation ({err}) — change the selection to retry.
        </p>
      )}
      {data && <Recommendation data={data} confBadge={confBadge} />}
      {data && <DemandCard demand={data.demand} area={data.segment.area} />}
      {data && <CurveCard data={data} />}
      {listingId && <OutcomesCard listingId={listingId} nights={nights} />}
      <StrategyCard />
    </div>
  );
}

interface Outcomes {
  scope: "unit" | "portfolio";
  unitId: string | null;
  pace: { medianLeadDays: number | null; n: number; histogram: { key: string; label: string; count: number }[] };
  realizedNightly: { p25: number; p50: number; p75: number; n: number; currency: string | null } | null;
  recent: Array<{
    id: string;
    createdOn: string | null;
    arrival: string | null;
    nightly: number | null;
    source: string | null;
    status: string | null;
    leadDays: number | null;
  }>;
  marketPace: { medianLeadDays: number | null } | null;
  paceDeltaDays: number | null;
}

function OutcomesCard({ listingId, nights }: { listingId: string; nights: number }) {
  const [o, setO] = useState<Outcomes | null>(null);
  useEffect(() => {
    fetch(`/api/learning/outcomes?listingId=${listingId}&nights=${nights}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setO)
      .catch(() => setO(null));
  }, [listingId, nights]);

  if (!o) return null;
  const hasData = (o.realizedNightly?.n ?? 0) > 0 || o.pace.n > 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Booking outcomes · MiniHotel</CardTitle>
          <Badge variant={o.scope === "unit" ? "info" : "muted"}>
            {o.scope === "unit" ? "this unit" : "portfolio"}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          What actually booked — realized price and how far ahead. Our pace is the benchmark to
          compare against market booking lead times (M5), and the truth behind strategy success (M6).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasData ? (
          <p className="text-[11px] text-muted-foreground">
            No bookings synced yet — run the MiniHotel bookings sync (POST
            /api/integrations/minihotel/bookings).
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-10 gap-y-3">
              {o.realizedNightly && (
                <Stat
                  label={`Realized nightly (n=${o.realizedNightly.n})`}
                  value={`${fmtMoney(o.realizedNightly.p50)}/n`}
                  sub={`${fmtMoney(o.realizedNightly.p25)}–${fmtMoney(o.realizedNightly.p75)}`}
                />
              )}
              <Stat
                label={`Our pace (n=${o.pace.n})`}
                value={o.pace.medianLeadDays != null ? `~${o.pace.medianLeadDays}d out` : "—"}
                sub="median booking lead"
              />
              {o.marketPace?.medianLeadDays != null && (
                <Stat
                  label="Pace vs market"
                  value={
                    o.paceDeltaDays != null
                      ? `${o.paceDeltaDays === 0 ? "on pace" : `${Math.abs(o.paceDeltaDays)}d ${o.paceDeltaDays < 0 ? "earlier" : "later"}`}`
                      : "—"
                  }
                  sub={`market ~${o.marketPace.medianLeadDays}d out`}
                />
              )}
            </div>
            {o.marketPace?.medianLeadDays == null && (
              <p className="text-[11px] text-muted-foreground">
                Add market booking lead times to compare pace (POST /api/learning/market-pace).
              </p>
            )}
            {o.recent.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">Booked</th>
                      <th className="px-2 py-1 text-left">Arrival</th>
                      <th className="px-2 py-1 text-right">Lead</th>
                      <th className="px-2 py-1 text-right">Nightly</th>
                      <th className="px-2 py-1 text-left">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.recent.slice(0, 8).map((b) => (
                      <tr key={b.id} className="border-t border-border/40">
                        <td className="px-2 py-1 font-mono text-muted-foreground">{b.createdOn ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{b.arrival ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{b.leadDays != null ? `${b.leadDays}d` : "—"}</td>
                        <td className="px-2 py-1 text-right font-mono">{fmtMoney(b.nightly)}</td>
                        <td className="px-2 py-1">{b.source ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Recommendation({ data, confBadge }: { data: Elasticity; confBadge: React.ReactNode }) {
  const t = data.target;
  const drop = t?.deltaNightly != null && t.deltaNightly < 0;
  const headline = drop
    ? `Drop ${fmtMoney(Math.abs(t!.deltaNightly!))}/night (${t!.deltaPct}%) → page ${t!.page}`
    : data.note
      ? data.note
      : "—";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>
            {data.segment.area} · {nightsLabel(data.nights)} ·{" "}
            {data.leadDays != null ? `${data.leadDays}d lead` : "—"} ({data.segment.leadBucket})
          </CardTitle>
          <span className="flex items-center gap-1.5">
            {data.demand?.label && <DemandBadge label={data.demand.label} />}
            {confBadge}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={`text-xl font-semibold tracking-tight ${
            drop ? "text-[hsl(var(--danger))]" : "text-foreground"
          }`}
        >
          {headline}
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <Stat
            label="Current"
            value={`${fmtMoney(data.current.nightly)}/n`}
            sub={
              data.current.found && data.current.page
                ? `page ${data.current.page}`
                : data.current.expectedPage
                  ? `~page ${data.current.expectedPage} (modeled)`
                  : "not in search"
            }
          />
          {t?.nightly != null && (
            <Stat
              label={`Price for page ${t.page}`}
              value={`${fmtMoney(t.nightly)}/n`}
              sub={
                data.confidence.ciNightlyLow != null
                  ? `±range ${fmtMoney(data.confidence.ciNightlyLow)}–${fmtMoney(
                      data.confidence.ciNightlyHigh,
                    )}`
                  : undefined
              }
            />
          )}
          {data.marginal.positionsPer100Nightly != null && (
            <Stat
              label="Each ₪100/night"
              value={`≈ ${data.marginal.positionsPer100Nightly} pos`}
              sub={
                data.marginal.positionsPerPct != null
                  ? `1% ≈ ${data.marginal.positionsPerPct} pos`
                  : undefined
              }
            />
          )}
          {data.revenue.delta != null && (
            <Stat
              label={`Revenue / ${nightsLabel(data.revenue.nights)}`}
              value={`${fmtMoney(data.revenue.before)} → ${fmtMoney(data.revenue.after)}`}
              sub={`${data.revenue.delta >= 0 ? "+" : ""}${fmtMoney(data.revenue.delta)}`}
            />
          )}
          {data.economics?.rentKnown && data.economics.profitBefore != null && (
            <Stat
              label="Profit / mo"
              value={`${fmtMoney(data.economics.profitBefore)} → ${fmtMoney(data.economics.profitAfter)}`}
              sub={
                data.economics.marginBefore != null
                  ? `margin ${data.economics.marginBefore}% → ${data.economics.marginAfter}%`
                  : undefined
              }
            />
          )}
        </div>

        {drop && data.note && <p className="text-[11px] text-muted-foreground">{data.note}</p>}
        {data.model.offsetN >= 2 && (
          <p className="text-[11px] text-muted-foreground">
            Model B: this listing ranks {Math.abs(data.model.offsetRank)} positions{" "}
            {data.model.offsetRank <= 0 ? "better" : "worse"} than its price implies (from{" "}
            {data.model.offsetN} appearances)
            {data.model.ownPositionsPerPct != null &&
              `; observed own sensitivity ≈ ${data.model.ownPositionsPerPct} pos per 1% cut (n=${data.model.ownN})`}
            .
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Based on {data.confidence.n} market listings
          {data.confidence.freshnessDays != null && ` · scanned ${data.confidence.freshnessDays}d ago`}.
          Model A (cross-sectional market curve). When confident, this drives the ▼ Lower suggestion
          in Search &amp; Profit.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

interface AttributionReport {
  strategies: Array<{
    strategy: "after-drop" | "after-raise" | "no-change";
    n: number;
    medianRealizedPctOfAsking: number | null;
    medianLeadDays: number | null;
    medianDaysFromChange: number | null;
  }>;
  followThrough: { windowDays: number; drops: number; dropsBooked: number; raises: number; raisesBooked: number };
  unattributed: number;
}

const STRATEGY_LABELS: Record<string, string> = {
  "after-drop": "▼ After a drop",
  "after-raise": "▲ After a raise",
  "no-change": "No recent change",
};

// Portfolio-wide: how bookings closed relative to asking, grouped by the price
// action that preceded them — the "success rate over strategy" view.
function StrategyCard() {
  const [r, setR] = useState<AttributionReport | null>(null);
  useEffect(() => {
    fetch("/api/learning/attribution", { cache: "no-store" })
      .then((res) => res.json())
      .then(setR)
      .catch(() => setR(null));
  }, []);

  if (!r) return null;
  const total = r.strategies.reduce((s, x) => s + x.n, 0);
  const ft = r.followThrough;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Strategy outcomes · portfolio</CardTitle>
          <Badge variant="muted">{total} attributed</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Each booking joined to the asking price, search position, and price action live when it
          was booked — how each strategy actually converts.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {total === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No attributable bookings yet — sync MiniHotel bookings and map listings to units in
            Manage so they join up.
            {r.unattributed > 0 && ` (${r.unattributed} booking(s) lack a listing↔unit link.)`}
          </p>
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-[11px]">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Strategy</th>
                    <th className="px-2 py-1 text-right">Bookings</th>
                    <th className="px-2 py-1 text-right">Realized vs asking</th>
                    <th className="px-2 py-1 text-right">Lead</th>
                    <th className="px-2 py-1 text-right">Days from move</th>
                  </tr>
                </thead>
                <tbody>
                  {r.strategies.map((s) => (
                    <tr key={s.strategy} className="border-t border-border/40">
                      <td className="px-2 py-1">{STRATEGY_LABELS[s.strategy] ?? s.strategy}</td>
                      <td className="px-2 py-1 text-right font-mono">{s.n}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {s.medianRealizedPctOfAsking != null ? `${Math.round(s.medianRealizedPctOfAsking)}%` : "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {s.medianLeadDays != null ? `${Math.round(s.medianLeadDays)}d` : "—"}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {s.medianDaysFromChange != null ? `${Math.round(s.medianDaysFromChange)}d` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {ft.drops > 0
                ? `Follow-through: ${ft.dropsBooked}/${ft.drops} logged drops were followed by a booking within ${ft.windowDays}d` +
                  (ft.raises > 0 ? `; raises ${ft.raisesBooked}/${ft.raises}.` : ".")
                : `No logged price moves yet — log them (POST /api/learning/price-changes) when you change a price, and conversions get attributed to the move.`}
              {r.unattributed > 0 && ` ${r.unattributed} booking(s) couldn't be attributed (no listing↔unit link).`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------- suggestion scorecard
interface ScorecardRow {
  changeId: string;
  label: string;
  ts: string;
  deltaPct: number | null;
  targetPage: number;
  realizedPage: number | null;
  scans: number;
  rankOutcome: "hit" | "miss" | "pending";
  windowOpen: boolean;
  unitMapped: boolean;
  booked: boolean;
}
interface ScorecardData {
  windowDays: number;
  rows: ScorecardRow[];
  summary: {
    total: number;
    hits: number;
    misses: number;
    pending: number;
    decided: number;
    hitRate: number | null;
    unitMapped: number;
    bookedWithinWindow: number;
  };
}

function OutcomeBadge({ row }: { row: ScorecardRow }) {
  if (row.rankOutcome === "hit") return <Badge variant="success">page {row.targetPage} ✓</Badge>;
  if (row.rankOutcome === "miss") return <Badge variant="danger">missed</Badge>;
  return <Badge variant="muted">{row.scans === 0 ? "awaiting scan" : "pending"}</Badge>;
}

// Per-suggestion closed loop: each APPLIED learned suggestion, scored against the
// scans + bookings that followed. The prediction (target page) was captured at
// apply time; the verdict here is derived live from what actually happened.
function ScorecardCard() {
  const [d, setD] = useState<ScorecardData | null>(null);
  useEffect(() => {
    fetch("/api/learning/scorecard", { cache: "no-store" })
      .then((r) => r.json())
      .then(setD)
      .catch(() => setD(null));
  }, []);

  if (!d) return null;
  const s = d.summary;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Suggestion scorecard</CardTitle>
          <Badge variant="muted">{s.total} applied</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Every applied suggestion scored against what happened next: did the listing reach the
          target page within {d.windowDays}d, and did the mapped unit book?
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {s.total === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No applied suggestions yet — Apply one above and its prediction gets scored here as new
            scans (and bookings) come in.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[11px]">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Listing</th>
                    <th className="px-2 py-1 text-left">Applied</th>
                    <th className="px-2 py-1 text-right">Move</th>
                    <th className="px-2 py-1 text-right">Target → reached</th>
                    <th className="px-2 py-1 text-left">Result</th>
                    <th className="px-2 py-1 text-left">Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.slice(0, 10).map((r) => (
                    <tr key={r.changeId} className="border-t border-border/40">
                      <td className="max-w-[14rem] truncate px-2 py-1 font-medium" title={r.label}>
                        {r.label}
                      </td>
                      <td className="px-2 py-1 font-mono text-muted-foreground">{r.ts.slice(0, 10)}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {r.deltaPct != null ? `${r.deltaPct > 0 ? "+" : ""}${r.deltaPct}%` : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        p{r.targetPage} → {r.realizedPage != null ? `p${r.realizedPage}` : "—"}
                      </td>
                      <td className="px-2 py-1">
                        <OutcomeBadge row={r} />
                      </td>
                      <td className="px-2 py-1">
                        {!r.unitMapped ? (
                          <span className="text-muted-foreground">unmapped</span>
                        ) : r.booked ? (
                          <Badge variant="success">booked ✓</Badge>
                        ) : (
                          <span className="text-muted-foreground">{r.windowOpen ? "—" : "no"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {s.decided > 0
                ? `Reached the target page ${s.hits}/${s.decided} times${
                    s.hitRate != null ? ` (${Math.round(s.hitRate * 100)}%)` : ""
                  }`
                : "No suggestion has a settled rank outcome yet"}
              {s.pending > 0 && ` · ${s.pending} still pending`}
              {s.unitMapped > 0 &&
                ` · ${s.bookedWithinWindow}/${s.unitMapped} mapped unit(s) booked within ${d.windowDays}d`}
              .
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DemandBadge({ label }: { label: NonNullable<DemandSignal["label"]> }) {
  const v =
    label === "hot" ? "danger" : label === "firm" ? "success" : label === "soft" ? "info" : "muted";
  return <Badge variant={v}>demand {label}</Badge>;
}

// Relative demand for the selected check-in. The point of this card: the raw
// market number is NOT trusted at face value (ghost listings sink it); it's read
// against its own range, with our realized occupancy beside it as the anchor.
function DemandCard({ demand, area }: { demand: DemandSignal | null; area: string }) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setMsg(null);
    try {
      const res = await fetch("/api/learning/demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, text }),
      });
      const b = (await res.json()) as { recorded?: number; error?: string };
      setMsg(res.ok ? `recorded ${b.recorded} reading(s) — refresh to see them applied` : b.error ?? "failed");
      if (res.ok) setText("");
    } catch {
      setMsg("failed to post readings");
    }
  }

  const m = demand?.market ?? null;
  const s = demand?.supply ?? null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Demand · {demand?.date ?? "—"}</CardTitle>
          {demand?.label ? <DemandBadge label={demand.label} /> : <Badge variant="muted">no data</Badge>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Market readings are treated as <span className="text-foreground">relative</span> — ghost
          listings make the absolute level meaningless, so each reading is scored against its own
          history for this area.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
          {m ? (
            <Stat
              label="Market reading"
              value={`${m.raw}%`}
              sub={`p${m.percentile} of its own range (n=${m.n}) → ${
                demand?.label ?? "—"
              }`}
            />
          ) : (
            <Stat label="Market reading" value="—" sub="paste readings below to enable" />
          )}
          {s && (
            <Stat
              label="Listings on market"
              value={String(s.raw)}
              sub={`p${s.percentile} for this lead window — ${
                s.index > 0 ? "thinner than usual (hot)" : s.index < 0 ? "fatter than usual (soft)" : "typical"
              }`}
            />
          )}
          {demand?.ourOccupancy != null && (
            <Stat
              label="Our occupancy"
              value={`${Math.round(demand.ourOccupancy * 100)}%`}
              sub="realized, around this date (MiniHotel)"
            />
          )}
        </div>
        {m && demand?.ourOccupancy != null && (
          <p className="text-[11px] text-muted-foreground">
            Calibration: the dashboard says {m.raw}% while we run{" "}
            {Math.round(demand.ourOccupancy * 100)}% — whenever this metric reads at p
            {m.percentile} of its range, treat the market as{" "}
            <span className="text-foreground">{demand.label}</span> regardless of the absolute
            number.
          </p>
        )}
        <div>
          <button
            type="button"
            onClick={() => setPasteOpen((o) => !o)}
            className="text-[11px] text-primary hover:underline"
          >
            {pasteOpen ? "close" : "paste market readings…"}
          </button>
          {pasteOpen && (
            <div className="mt-2 space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                placeholder={"One per line: YYYY-MM-DD value\n2026-08-01 30\n2026-08-08 28.5"}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary/50"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={!text.trim()}
                  className="rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-60"
                >
                  Record for {area}
                </button>
                {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CurveCard({ data }: { data: Elasticity }) {
  const cur = data.current;
  const t = data.target;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Market price → position curve</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The price the market pays for each position in this segment (page 1 at top). Blue = you
          now; green = the price to reach page {t?.page ?? 1}.
        </p>
      </CardHeader>
      <CardContent>
        {data.curve.length < 2 ? (
          <p className="text-[11px] text-muted-foreground">
            {data.note ?? "Not enough market data yet — run scans to build the ladder."}
          </p>
        ) : (
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <ComposedChart data={data.curve} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                <XAxis
                  type="number"
                  dataKey="nightly"
                  tick={{ fontSize: 10 }}
                  stroke={CHART.axis}
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v) => fmtMoney(Number(v))}
                  label={{ value: "nightly price", position: "insideBottom", offset: -8, fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="expectedPage"
                  reversed
                  allowDecimals={false}
                  tick={{ fontSize: 10 }}
                  stroke={CHART.axis}
                  label={{ value: "page", angle: -90, position: "insideLeft", fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(value) => [`page ${value}`, "expected"] as [string, string]}
                  labelFormatter={(label) => fmtMoney(Number(label))}
                />
                <Line type="monotone" dataKey="expectedPage" stroke={CHART.blue} strokeWidth={2} dot={false} />
                {cur.nightly != null && cur.expectedPage != null && (
                  <ReferenceDot x={cur.nightly} y={cur.expectedPage} r={5} fill={CHART.blue} stroke="white" />
                )}
                {t?.nightly != null && (
                  <ReferenceDot x={t.nightly} y={t.page} r={5} fill={CHART.green} stroke="white" />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
