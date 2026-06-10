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
  curve: CurvePoint[];
  note: string | null;
}

const selectCls =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));

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

  // Fetch the recommendation whenever the selection changes.
  useEffect(() => {
    if (!listingId) return;
    const params = new URLSearchParams({
      listingId,
      nights: String(nights),
      targetPage: String(targetPage),
    });
    if (checkIn) params.set("checkIn", checkIn);
    fetch(`/api/learning/elasticity?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((b: Elasticity) => setData(b))
      .catch((e) => setErr(e instanceof Error ? e.message : "failed to load"));
  }, [listingId, nights, checkIn, targetPage]);

  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (err) return <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>;
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

      {data && <Recommendation data={data} confBadge={confBadge} />}
      {data && <CurveCard data={data} />}
    </div>
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
          {confBadge}
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
