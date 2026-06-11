"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

const SENS_OPTIONS = [
  { value: "none", label: "No Seasonality" },
  { value: "conservative", label: "Conservative" },
  { value: "moderately_conservative", label: "Moderately Conservative" },
  { value: "recommended", label: "Recommended (default)" },
  { value: "moderately_aggressive", label: "Moderately Aggressive" },
  { value: "aggressive", label: "Aggressive" },
];

// Form state mirrors the API's effective config; percents shown as % (stored as
// fractions server-side where noted). Adjacent/offset values are signed:
// negative = discount, positive = premium.
interface Form {
  seasonalityOn: boolean;
  seasonalitySens: string;
  demandOn: boolean;
  demandCapPct: string;
  pacingOn: boolean;
  pacingSensPct: string;
  pacingCapPct: string;
  occupancyOn: boolean;
  farOutOn: boolean;
  farOutDays: string;
  farOutCapPct: string;
  farOutRampDays: string;
  lastMinuteOn: boolean;
  lastMinWindow: string;
  lastMinMaxPct: string;
  adjacentOn: boolean;
  adjacentMode: string;
  adjacentValue: string;
  adjacentBefore: string;
  adjacentAfter: string;
  adjacentWeekends: boolean;
  dayOfWeekOn: boolean;
  losOn: boolean;
  losQuarterNights: string;
  losQuarterPct: string;
  offsetOn: boolean;
  offsetMode: string;
  offsetValue: string;
  minStayFarOutDays: string;
  minStayFarOutNights: string;
  currentRateLeadDays: string;
  humanGatePct: string;
}

interface EffectiveResp {
  effective: {
    currentRateLeadDays: number;
    seasonality: { enabled: boolean; sensitivity: string };
    demandEvents: { enabled: boolean; cap: number };
    pacing: { enabled: boolean; sensitivity: number; cap: number };
    occupancy: { enabled: boolean };
    farOut: { enabled: boolean; thresholdDays: number; cap: number; rampDays: number };
    lastMinute: { enabled: boolean; windowDays: number; maxDiscount: number };
    adjacent: {
      enabled: boolean;
      mode: "percent" | "fixed";
      value: number;
      daysBefore: number;
      daysAfter: number;
      applyOnWeekends: boolean;
    };
    dayOfWeek: { enabled: boolean };
    los: { enabled: boolean; quarterlyMinNights: number; quarterlyDiscountPct: number };
    pricingOffset: { enabled: boolean; mode: "percent" | "fixed"; value: number };
    minStayHierarchy: { farOutThresholdDays: number; farOutNights: number };
    humanGatePct: number;
  };
}

interface PreviewUnit {
  id: string;
  name: string;
  neighborhood: string;
}

interface PreviewPoint {
  date: string;
  current: number;
  candidate: number;
  defaults: number;
  booked: boolean;
}

const pct = (f: number) => String(Math.round(f * 1000) / 10);
const frac = (s: string) => (parseFloat(s) || 0) / 100;

function toForm(e: EffectiveResp["effective"]): Form {
  return {
    seasonalityOn: e.seasonality.enabled,
    seasonalitySens: e.seasonality.sensitivity || "recommended",
    demandOn: e.demandEvents.enabled,
    demandCapPct: pct(e.demandEvents.cap),
    pacingOn: e.pacing.enabled,
    pacingSensPct: pct(e.pacing.sensitivity),
    pacingCapPct: pct(e.pacing.cap),
    occupancyOn: e.occupancy.enabled,
    farOutOn: e.farOut.enabled,
    farOutDays: String(e.farOut.thresholdDays),
    farOutCapPct: pct(e.farOut.cap),
    farOutRampDays: String(e.farOut.rampDays),
    lastMinuteOn: e.lastMinute.enabled,
    lastMinWindow: String(e.lastMinute.windowDays),
    lastMinMaxPct: pct(e.lastMinute.maxDiscount),
    adjacentOn: e.adjacent.enabled,
    adjacentMode: e.adjacent.mode,
    adjacentValue: e.adjacent.mode === "percent" ? pct(e.adjacent.value) : String(e.adjacent.value),
    adjacentBefore: String(e.adjacent.daysBefore),
    adjacentAfter: String(e.adjacent.daysAfter),
    adjacentWeekends: e.adjacent.applyOnWeekends,
    dayOfWeekOn: e.dayOfWeek.enabled,
    losOn: e.los.enabled,
    losQuarterNights: String(e.los.quarterlyMinNights),
    losQuarterPct: pct(e.los.quarterlyDiscountPct),
    offsetOn: e.pricingOffset.enabled,
    offsetMode: e.pricingOffset.mode,
    offsetValue:
      e.pricingOffset.mode === "percent" ? pct(e.pricingOffset.value) : String(e.pricingOffset.value),
    minStayFarOutDays: String(e.minStayHierarchy.farOutThresholdDays),
    minStayFarOutNights: String(e.minStayHierarchy.farOutNights),
    currentRateLeadDays: String(e.currentRateLeadDays),
    humanGatePct: String(e.humanGatePct),
  };
}

export function EngineRulesCard() {
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Preview Prices Graph state
  const [units, setUnits] = useState<PreviewUnit[]>([]);
  const [pvUnit, setPvUnit] = useState("");
  const [pvHorizon, setPvHorizon] = useState(90);
  const [pvPoints, setPvPoints] = useState<PreviewPoint[] | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const [pvStale, setPvStale] = useState(false);

  async function load() {
    const res = await fetch("/api/pricing/rules", { cache: "no-store" });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const b = (await res.json()) as EffectiveResp;
    setF(toForm(b.effective));
  }

  useEffect(() => {
    load().catch((e) => setErr(e instanceof Error ? e.message : "failed to load"));
    fetch("/api/pricing/preview", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`units: ${r.status}`))))
      .then((b: { units: PreviewUnit[] }) => {
        setUnits(b.units);
        setPvUnit((cur) => cur || b.units[0]?.id || "");
      })
      .catch(() => setUnits([]));
  }, []);

  if (err) return <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>;
  if (!f) return null;

  const set = (k: keyof Form, v: string | boolean) => {
    setF((c) => (c ? { ...c, [k]: v } : c));
    setPvStale(true);
  };

  const toggle = (label: string, k: keyof Form) => (
    <label key={k} className="inline-flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={f[k] as boolean}
        onChange={(e) => set(k, e.target.checked)}
        className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
      />
      {label}
    </label>
  );
  const num = (label: string, k: keyof Form, w = "w-20") => (
    <label key={k} className="flex flex-col gap-1">
      {label}
      <input className={`${input} ${w}`} value={f[k] as string} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const select = (label: string, k: keyof Form, options: { value: string; label: string }[], w = "w-40") => (
    <label key={k} className="flex flex-col gap-1">
      {label}
      <select className={`${input} ${w}`} value={f[k] as string} onChange={(e) => set(k, e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  // The exact patch a Save would persist — also what the preview simulates.
  function buildPatch() {
    if (!f) return {};
    return {
      currentRateLeadDays: parseInt(f.currentRateLeadDays, 10) || 0,
      humanGatePct: parseFloat(f.humanGatePct) || 15,
      seasonality: { enabled: f.seasonalityOn, sensitivity: f.seasonalitySens },
      demandEvents: { enabled: f.demandOn, cap: frac(f.demandCapPct) },
      pacing: { enabled: f.pacingOn, sensitivity: frac(f.pacingSensPct), cap: frac(f.pacingCapPct) },
      occupancy: { enabled: f.occupancyOn },
      farOut: {
        enabled: f.farOutOn,
        thresholdDays: parseInt(f.farOutDays, 10) || 0,
        cap: frac(f.farOutCapPct),
        rampDays: parseInt(f.farOutRampDays, 10) || 1,
      },
      lastMinute: {
        enabled: f.lastMinuteOn,
        windowDays: parseInt(f.lastMinWindow, 10) || 0,
        maxDiscount: frac(f.lastMinMaxPct),
      },
      adjacent: {
        enabled: f.adjacentOn,
        mode: f.adjacentMode === "fixed" ? "fixed" : "percent",
        value: f.adjacentMode === "fixed" ? parseFloat(f.adjacentValue) || 0 : frac(f.adjacentValue),
        daysBefore: parseInt(f.adjacentBefore, 10) || 0,
        daysAfter: parseInt(f.adjacentAfter, 10) || 0,
        applyOnWeekends: f.adjacentWeekends,
      },
      dayOfWeek: { enabled: f.dayOfWeekOn },
      los: {
        enabled: f.losOn,
        quarterlyMinNights: parseInt(f.losQuarterNights, 10) || 90,
        quarterlyDiscountPct: frac(f.losQuarterPct),
      },
      pricingOffset: {
        enabled: f.offsetOn,
        mode: f.offsetMode === "fixed" ? "fixed" : "percent",
        value: f.offsetMode === "fixed" ? parseFloat(f.offsetValue) || 0 : frac(f.offsetValue),
      },
      minStayHierarchy: {
        farOutThresholdDays: parseInt(f.minStayFarOutDays, 10) || 90,
        farOutNights: parseInt(f.minStayFarOutNights, 10) || 60,
      },
    };
  }

  async function save() {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPatch()),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function resetAll() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (!res.ok) throw new Error(`reset failed: ${res.status}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function reviewChanges() {
    if (!pvUnit) return;
    setPvBusy(true);
    setPvErr(null);
    try {
      const res = await fetch("/api/pricing/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unitId: pvUnit, horizonDays: pvHorizon, candidate: buildPatch() }),
      });
      if (!res.ok) throw new Error(`preview failed: ${res.status}`);
      const b = (await res.json()) as { points: PreviewPoint[] };
      setPvPoints(b.points);
      setPvStale(false);
    } catch (e) {
      setPvErr(e instanceof Error ? e.message : "preview failed");
    } finally {
      setPvBusy(false);
    }
  }

  const chartData = (pvPoints ?? []).map((p) => ({
    ...p,
    bookedDot: p.booked ? p.candidate : null,
  }));

  return (
    <Card id="engine-rules">
      <CardHeader className="pb-3">
        <CardTitle>Pricing engine rules</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The rule stack behind the Pricing Engine tab (base × seasonality × demand × pace ×
          occupancy × lead-time × adjacency, clamped to each unit&apos;s floor/ceiling, then the
          pricing offset on top). Changes apply on the next pricing pass — no redeploy.
          Last-minute, day-of-week and the adjacent factor ship off: they&apos;re short-stay
          mechanics that rarely fit 30+ night rentals.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {toggle("Seasonality", "seasonalityOn")}
          {toggle("Demand / events", "demandOn")}
          {toggle("Booking pace", "pacingOn")}
          {toggle("Occupancy bands", "occupancyOn")}
          {toggle("Far-out premium", "farOutOn")}
          {toggle("Last-minute discount", "lastMinuteOn")}
          {toggle("Adjacent factor", "adjacentOn")}
          {toggle("Day-of-week", "dayOfWeekOn")}
          {toggle("LOS / quarter discount", "losOn")}
          {toggle("Pricing offset", "offsetOn")}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          {select("Seasonality sensitivity", "seasonalitySens", SENS_OPTIONS)}
          {num("Demand cap %", "demandCapPct")}
          {num("Pace sensitivity %", "pacingSensPct")}
          {num("Pace cap %", "pacingCapPct")}
          {num("Far-out ≥ days", "farOutDays")}
          {num("Far-out cap %", "farOutCapPct")}
          {num("Far-out ramp days", "farOutRampDays")}
          {num("Last-min window d", "lastMinWindow")}
          {num("Last-min max %", "lastMinMaxPct")}
          {num("Quarter ≥ nights", "losQuarterNights")}
          {num("Quarter disc %", "losQuarterPct")}
          {num("Min-stay far-out ≥ d", "minStayFarOutDays")}
          {num("Min-stay far-out n", "minStayFarOutNights")}
          {num("Headline lead days", "currentRateLeadDays")}
          {num("Human gate ±%", "humanGatePct")}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
          <span className="w-full text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            Adjacent factor — open days around bookings (discount fills gaps, premium discourages
            back-to-back turnovers; largest discount wins vs last-minute, premiums stack)
          </span>
          {select(
            "Type",
            "adjacentMode",
            [
              { value: "percent", label: "Percent" },
              { value: "fixed", label: "Fixed (₪)" },
            ],
            "w-28",
          )}
          {num(f.adjacentMode === "fixed" ? "Value ₪ (− disc / + prem)" : "Value % (− disc / + prem)", "adjacentValue", "w-28")}
          {num("Days before booking", "adjacentBefore")}
          {num("Days after booking", "adjacentAfter")}
          {toggle("Also apply on weekends", "adjacentWeekends")}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
          <span className="w-full text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            Pricing offset — applied after every other rule, the min/max clamp and fixed overrides
            (can push the final rate outside the unit&apos;s floor/ceiling; discount caps at 40,
            premium at 500)
          </span>
          {select(
            "Type",
            "offsetMode",
            [
              { value: "percent", label: "Percent" },
              { value: "fixed", label: "Fixed (₪)" },
            ],
            "w-28",
          )}
          {num(f.offsetMode === "fixed" ? "Value ₪ (− disc / + prem)" : "Value % (− disc / + prem)", "offsetValue", "w-28")}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={save} className={btn}>
            {saved ? "Saved ✓" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={resetAll}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            Reset to defaults
          </button>
          <span className="text-[10px] text-muted-foreground/70">
            Per-unit floor/ceiling &amp; monthly discounts live on the units themselves. Removing a
            restriction never retracts it from MiniHotel by itself — clearing overrides re-pushes
            the defaults in the same action (Rates Calendar → Date Specific Overrides).
          </span>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <span className="text-xs font-medium text-foreground">Preview prices</span>
            <label className="flex flex-col gap-1">
              Listing
              <select className={`${input} w-48`} value={pvUnit} onChange={(e) => setPvUnit(e.target.value)}>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {u.neighborhood}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Timeframe
              <select
                className={`${input} w-28`}
                value={pvHorizon}
                onChange={(e) => setPvHorizon(parseInt(e.target.value, 10))}
              >
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
                <option value={183}>6 months</option>
                <option value={365}>1 year</option>
              </select>
            </label>
            <button type="button" disabled={pvBusy || !pvUnit} onClick={reviewChanges} className={btn}>
              {pvBusy ? "Computing…" : "Review changes"}
            </button>
            {pvStale && pvPoints && (
              <span className="text-[10px] text-amber-600">settings changed — review again</span>
            )}
          </div>
          {pvErr && <p className="text-[11px] text-[hsl(var(--danger))]">{pvErr}</p>}
          {pvPoints && (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215 16% 47%)" minTickGap={28} />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="hsl(215 16% 47%)"
                    width={48}
                    domain={["auto", "auto"]}
                    tickFormatter={(v: number) => `₪${v}`}
                  />
                  <Tooltip
                    formatter={(value) => (value == null ? "—" : `₪${value}`)}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="defaults"
                    name="Default customizations"
                    stroke="#334155"
                    strokeWidth={1.5}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="current"
                    name="Current (saved)"
                    stroke="#dc2626"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="candidate"
                    name="Edited (unsaved)"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="bookedDot"
                    name="Booked nights"
                    stroke="none"
                    dot={{ r: 2.5, fill: "#16a34a", strokeWidth: 0 }}
                    legendType="circle"
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-muted-foreground/70">
                Red dashed = saved rules today · blue = these edits (not saved) · dark = code-default
                customizations only · green dots = nights already booked. Nothing is applied until
                you click Save.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
