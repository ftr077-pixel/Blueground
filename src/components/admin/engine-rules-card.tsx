"use client";

import { useCallback, useEffect, useState } from "react";
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
const btnGhost =
  "rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-50";
const sectionBox = "rounded-md border border-border/60 bg-muted/20 p-3 space-y-3";
const sectionHead = "text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80";

const SENS_OPTIONS = [
  { value: "none", label: "No Seasonality" },
  { value: "conservative", label: "Conservative" },
  { value: "moderately_conservative", label: "Moderately Conservative" },
  { value: "recommended", label: "Recommended (default)" },
  { value: "moderately_aggressive", label: "Moderately Aggressive" },
  { value: "aggressive", label: "Aggressive" },
];
const MIN_PRICE_MODES = [
  { value: "fixed", label: "Fixed ₪" },
  { value: "pctBase", label: "% of base" },
  { value: "pctMin", label: "% of min" },
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface OrphanRow {
  upTo: string;
  mode: string;
  weekday: string;
  weekend: string;
  withinDays: string;
}
interface LmRow {
  withinDays: string;
  weekday: string;
  weekend: string;
}
interface ObaRow {
  uptoDays: string;
  soft: string;
  healthy: string;
  tight: string;
  full: string;
}

// Form state mirrors the API's effective config; percents shown as % (stored as
// fractions server-side where noted). Signed values: negative = discount.
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
  // Weekend Days customization
  weekendDays: boolean[];
  // Orphan Day Prices
  orphanOn: boolean;
  orphanRanges: OrphanRow[];
  // Portfolio occupancy
  pobaOn: boolean;
  pobaProfile: string;
  pobaWindows: ObaRow[];
  // Advanced minimum prices
  mpFarOutOn: boolean;
  mpFarOutDays: string;
  mpFarOutMode: string;
  mpFarOutValue: string;
  mpWeekendOn: boolean;
  mpWeekendMode: string;
  mpWeekendValue: string;
  mpLastMinOn: boolean;
  mpLastMinDays: string;
  mpLastMinMode: string;
  mpLastMinValue: string;
  mpOrphanOn: boolean;
  mpOrphanMode: string;
  mpOrphanValue: string;
  // Min-stay rules
  msMode: string;
  msHighest: string;
  msRule: string;
  msWeekday: string;
  msWeekend: string;
  msBookingValue: string;
  msLm: LmRow[];
  msAdjOn: boolean;
  msAdjAfter: string;
  msAdjBeforeFlush: boolean;
  msOrphanOn: boolean;
  msOrphanStrategy: string;
  msOrphanFixed: string;
  msOrphanMaxGap: string;
  msOrphanLowest: string;
  msAdaptiveOn: boolean;
}

interface EffectiveConfig {
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
  weekend: { days: number[] };
  orphanDayPrices: {
    enabled: boolean;
    ranges: Array<{
      upToGapNights: number;
      mode: "percent" | "fixed";
      weekday: number;
      weekend: number;
      withinDays: number | null;
    }>;
  };
  portfolioOccupancy: {
    enabled: boolean;
    profile: string;
    windows: Array<{ uptoDays: number; bands: Array<{ upTo: number; adjust: number; label: string }> }>;
  };
  minPrices: {
    farOut: { enabled: boolean; beyondDays: number; mode: string; value: number };
    weekend: { enabled: boolean; mode: string; value: number };
    lastMinute: { enabled: boolean; withinDays: number; mode: string; value: number };
    orphan: { enabled: boolean; mode: string; value: number };
  };
  minStayRules: {
    mode: string;
    highestAllowed: number;
    custom: { rule: string; weekday: number; weekend: number; bookingValue: number };
    lastMinute: Array<{ withinDays: number; weekday: number; weekend: number }>;
    adjacent: { enabled: boolean; afterNights: number; beforeFlushFit: boolean };
    orphanGap: {
      enabled: boolean;
      strategy: string;
      fixedNights: number;
      maxGapNights: number;
      lowestAllowed: number;
    };
    adaptiveOccupancy: { enabled: boolean };
  };
  minStayHierarchy: { farOutThresholdDays: number; farOutNights: number };
  humanGatePct: number;
}

interface RulesResp {
  effective: EffectiveConfig;
  groups: string[];
}

interface PreviewUnit {
  id: string;
  name: string;
  neighborhood: string;
  group?: string | null;
  subgroup?: string | null;
}

interface GroupInfo {
  name: string;
  members: number;
  asGroup: number;
  asSubgroup: number;
  occ30: number | null;
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
const int = (s: string, fb = 0) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fb;
};

function toForm(e: EffectiveConfig): Form {
  const orphanRanges: OrphanRow[] = [0, 1, 2].map((i) => {
    const r = e.orphanDayPrices.ranges[i];
    if (!r) return { upTo: "", mode: "percent", weekday: "", weekend: "", withinDays: "" };
    return {
      upTo: String(r.upToGapNights),
      mode: r.mode,
      weekday: r.mode === "percent" ? pct(r.weekday) : String(r.weekday),
      weekend: r.mode === "percent" ? pct(r.weekend) : String(r.weekend),
      withinDays: r.withinDays == null ? "" : String(r.withinDays),
    };
  });
  const pobaWindows: ObaRow[] = [0, 1, 2].map((i) => {
    const w = e.portfolioOccupancy.windows[i];
    if (!w) return { uptoDays: "", soft: "", healthy: "", tight: "", full: "" };
    const adj = (j: number) => (w.bands[j] ? pct(w.bands[j].adjust) : "0");
    return { uptoDays: String(w.uptoDays), soft: adj(0), healthy: adj(1), tight: adj(2), full: adj(3) };
  });
  const msLm: LmRow[] = [0, 1, 2].map((i) => {
    const r = e.minStayRules.lastMinute[i];
    return r
      ? { withinDays: String(r.withinDays), weekday: String(r.weekday), weekend: String(r.weekend) }
      : { withinDays: "", weekday: "", weekend: "" };
  });
  const mpVal = (mode: string, value: number) => (mode === "fixed" ? String(value) : pct(value));
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
    weekendDays: DOW.map((_, i) => e.weekend.days.includes(i)),
    orphanOn: e.orphanDayPrices.enabled,
    orphanRanges,
    pobaOn: e.portfolioOccupancy.enabled,
    pobaProfile: e.portfolioOccupancy.profile,
    pobaWindows,
    mpFarOutOn: e.minPrices.farOut.enabled,
    mpFarOutDays: String(e.minPrices.farOut.beyondDays),
    mpFarOutMode: e.minPrices.farOut.mode,
    mpFarOutValue: mpVal(e.minPrices.farOut.mode, e.minPrices.farOut.value),
    mpWeekendOn: e.minPrices.weekend.enabled,
    mpWeekendMode: e.minPrices.weekend.mode,
    mpWeekendValue: mpVal(e.minPrices.weekend.mode, e.minPrices.weekend.value),
    mpLastMinOn: e.minPrices.lastMinute.enabled,
    mpLastMinDays: String(e.minPrices.lastMinute.withinDays),
    mpLastMinMode: e.minPrices.lastMinute.mode,
    mpLastMinValue: mpVal(e.minPrices.lastMinute.mode, e.minPrices.lastMinute.value),
    mpOrphanOn: e.minPrices.orphan.enabled,
    mpOrphanMode: e.minPrices.orphan.mode,
    mpOrphanValue: mpVal(e.minPrices.orphan.mode, e.minPrices.orphan.value),
    msMode: e.minStayRules.mode,
    msHighest: String(e.minStayRules.highestAllowed),
    msRule: e.minStayRules.custom.rule,
    msWeekday: String(e.minStayRules.custom.weekday),
    msWeekend: String(e.minStayRules.custom.weekend),
    msBookingValue: String(e.minStayRules.custom.bookingValue || ""),
    msLm,
    msAdjOn: e.minStayRules.adjacent.enabled,
    msAdjAfter: String(e.minStayRules.adjacent.afterNights),
    msAdjBeforeFlush: e.minStayRules.adjacent.beforeFlushFit,
    msOrphanOn: e.minStayRules.orphanGap.enabled,
    msOrphanStrategy: e.minStayRules.orphanGap.strategy,
    msOrphanFixed: String(e.minStayRules.orphanGap.fixedNights),
    msOrphanMaxGap: String(e.minStayRules.orphanGap.maxGapNights),
    msOrphanLowest: String(e.minStayRules.orphanGap.lowestAllowed),
    msAdaptiveOn: e.minStayRules.adaptiveOccupancy.enabled,
  };
}

export function EngineRulesCard() {
  const [scope, setScope] = useState("account");
  const [groups, setGroups] = useState<string[]>([]);
  const [groupInfo, setGroupInfo] = useState<GroupInfo[]>([]);
  const [units, setUnits] = useState<PreviewUnit[]>([]);
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Groups manager state
  const [newGroup, setNewGroup] = useState("");
  const [assignGroup, setAssignGroup] = useState("");
  const [assignSub, setAssignSub] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Preview Prices Graph state
  const [pvUnit, setPvUnit] = useState("");
  const [pvHorizon, setPvHorizon] = useState(90);
  const [pvPoints, setPvPoints] = useState<PreviewPoint[] | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [pvErr, setPvErr] = useState<string | null>(null);
  const [pvStale, setPvStale] = useState(false);

  const load = useCallback(async (sc: string) => {
    const res = await fetch(`/api/pricing/rules?scope=${encodeURIComponent(sc)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const b = (await res.json()) as RulesResp;
    setGroups(b.groups);
    setF(toForm(b.effective));
  }, []);

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/pricing/groups", { cache: "no-store" });
    if (!res.ok) return;
    const b = (await res.json()) as { groups: GroupInfo[]; units: PreviewUnit[] };
    setGroupInfo(b.groups);
    setUnits(b.units);
    setPvUnit((cur) => cur || b.units[0]?.id || "");
  }, []);

  useEffect(() => {
    load(scope).catch((e) => setErr(e instanceof Error ? e.message : "failed to load"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    loadGroups().catch(() => undefined);
  }, [loadGroups]);

  if (err) return <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>;
  if (!f) return null;

  const set = (k: keyof Form, v: Form[keyof Form]) => {
    setF((c) => (c ? { ...c, [k]: v } : c));
    setPvStale(true);
  };
  const setRow = <T,>(k: "orphanRanges" | "pobaWindows" | "msLm", i: number, field: keyof T, v: string) => {
    setF((c) => {
      if (!c) return c;
      const rows = [...(c[k] as unknown as T[])];
      rows[i] = { ...rows[i], [field]: v };
      return { ...c, [k]: rows as never };
    });
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
  const cell = (k: "orphanRanges" | "pobaWindows" | "msLm", i: number, field: string, v: string, w = "w-16") => (
    <input
      className={`${input} ${w}`}
      value={v}
      onChange={(e) => setRow(k, i, field as never, e.target.value)}
    />
  );

  // The exact patch a Save would persist at this scope — also what the preview simulates.
  function buildPatch() {
    if (!f) return {};
    const mpv = (mode: string, s: string) => (mode === "fixed" ? parseFloat(s) || 0 : frac(s));
    return {
      currentRateLeadDays: int(f.currentRateLeadDays),
      humanGatePct: parseFloat(f.humanGatePct) || 15,
      seasonality: { enabled: f.seasonalityOn, sensitivity: f.seasonalitySens },
      demandEvents: { enabled: f.demandOn, cap: frac(f.demandCapPct) },
      pacing: { enabled: f.pacingOn, sensitivity: frac(f.pacingSensPct), cap: frac(f.pacingCapPct) },
      occupancy: { enabled: f.occupancyOn },
      farOut: {
        enabled: f.farOutOn,
        thresholdDays: int(f.farOutDays),
        cap: frac(f.farOutCapPct),
        rampDays: int(f.farOutRampDays, 1),
      },
      lastMinute: {
        enabled: f.lastMinuteOn,
        windowDays: int(f.lastMinWindow),
        maxDiscount: frac(f.lastMinMaxPct),
      },
      adjacent: {
        enabled: f.adjacentOn,
        mode: f.adjacentMode === "fixed" ? "fixed" : "percent",
        value: f.adjacentMode === "fixed" ? parseFloat(f.adjacentValue) || 0 : frac(f.adjacentValue),
        daysBefore: int(f.adjacentBefore),
        daysAfter: int(f.adjacentAfter),
        applyOnWeekends: f.adjacentWeekends,
      },
      dayOfWeek: { enabled: f.dayOfWeekOn },
      los: {
        enabled: f.losOn,
        quarterlyMinNights: int(f.losQuarterNights, 90),
        quarterlyDiscountPct: frac(f.losQuarterPct),
      },
      pricingOffset: {
        enabled: f.offsetOn,
        mode: f.offsetMode === "fixed" ? "fixed" : "percent",
        value: f.offsetMode === "fixed" ? parseFloat(f.offsetValue) || 0 : frac(f.offsetValue),
      },
      weekend: { days: f.weekendDays.flatMap((on, i) => (on ? [i] : [])) },
      orphanDayPrices: {
        enabled: f.orphanOn,
        ranges: f.orphanRanges
          .filter((r) => r.upTo.trim() !== "")
          .map((r) => ({
            upToGapNights: int(r.upTo, 2),
            mode: (r.mode === "fixed" ? "fixed" : "percent") as "fixed" | "percent",
            weekday: r.mode === "fixed" ? parseFloat(r.weekday) || 0 : frac(r.weekday),
            weekend: r.mode === "fixed" ? parseFloat(r.weekend) || 0 : frac(r.weekend),
            withinDays: r.withinDays.trim() === "" ? null : int(r.withinDays),
          })),
      },
      portfolioOccupancy: {
        enabled: f.pobaOn,
        profile: f.pobaProfile as "short" | "medium" | "long" | "custom",
        windows:
          f.pobaProfile === "custom"
            ? f.pobaWindows
                .filter((w) => w.uptoDays.trim() !== "")
                .map((w) => ({
                  uptoDays: int(w.uptoDays, 9999),
                  bands: [
                    { upTo: 0.5, adjust: frac(w.soft), label: "soft <50%" },
                    { upTo: 0.8, adjust: frac(w.healthy), label: "healthy 50–80%" },
                    { upTo: 0.95, adjust: frac(w.tight), label: "tight 80–95%" },
                    { upTo: 1.01, adjust: frac(w.full), label: "full 95%+" },
                  ],
                }))
            : undefined,
      },
      minPrices: {
        farOut: {
          enabled: f.mpFarOutOn,
          beyondDays: int(f.mpFarOutDays, 60),
          mode: f.mpFarOutMode,
          value: mpv(f.mpFarOutMode, f.mpFarOutValue),
        },
        weekend: { enabled: f.mpWeekendOn, mode: f.mpWeekendMode, value: mpv(f.mpWeekendMode, f.mpWeekendValue) },
        lastMinute: {
          enabled: f.mpLastMinOn,
          withinDays: int(f.mpLastMinDays, 14),
          mode: f.mpLastMinMode,
          value: mpv(f.mpLastMinMode, f.mpLastMinValue),
        },
        orphan: { enabled: f.mpOrphanOn, mode: f.mpOrphanMode, value: mpv(f.mpOrphanMode, f.mpOrphanValue) },
      },
      minStayRules: {
        mode: f.msMode === "custom" ? "custom" : "recommended",
        highestAllowed: int(f.msHighest, 90),
        custom: {
          rule: f.msRule === "bookingValue" ? "bookingValue" : "fixed",
          weekday: int(f.msWeekday, 30),
          weekend: int(f.msWeekend, 30),
          bookingValue: parseFloat(f.msBookingValue) || 0,
        },
        lastMinute: f.msLm
          .filter((r) => r.withinDays.trim() !== "")
          .map((r) => ({ withinDays: int(r.withinDays, 7), weekday: int(r.weekday, 1), weekend: int(r.weekend, 1) })),
        adjacent: { enabled: f.msAdjOn, afterNights: int(f.msAdjAfter, 30), beforeFlushFit: f.msAdjBeforeFlush },
        orphanGap: {
          enabled: f.msOrphanOn,
          strategy: f.msOrphanStrategy as "lengthOfGap" | "gapMinus1" | "gapMinus2" | "fixed",
          fixedNights: int(f.msOrphanFixed, 1),
          maxGapNights: int(f.msOrphanMaxGap, 4),
          lowestAllowed: int(f.msOrphanLowest, 1),
        },
        adaptiveOccupancy: { enabled: f.msAdaptiveOn },
      },
      minStayHierarchy: {
        farOutThresholdDays: int(f.minStayFarOutDays, 90),
        farOutNights: int(f.minStayFarOutNights, 60),
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
        body: JSON.stringify({ scope, ...buildPatch() }),
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

  async function resetScope() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, reset: true }),
      });
      if (!res.ok) throw new Error(`reset failed: ${res.status}`);
      await load(scope);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function groupsAction(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error || `request failed: ${res.status}`);
      }
      await loadGroups();
      await load(scope).catch(() => undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "group update failed");
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
        body: JSON.stringify({ unitId: pvUnit, horizonDays: pvHorizon, scope, candidate: buildPatch() }),
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

  const chartData = (pvPoints ?? []).map((p) => ({ ...p, bookedDot: p.booked ? p.candidate : null }));
  const scopeLabel =
    scope === "account" ? "account" : scope.startsWith("group:") ? `group "${scope.slice(6)}"` : "this listing";

  return (
    <Card id="engine-rules">
      <CardHeader className="pb-3">
        <CardTitle>Pricing engine rules</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The rule stack behind the Pricing Engine tab, editable per scope — account, customization
          group (attach as group or sub-group), or single listing. Resolution per customization:
          listing &gt; sub-group &gt; group &gt; account, most specific level wins outright
          (levels never combine). Changes apply on the next pricing pass — no redeploy.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label className="flex flex-col gap-1">
            Editing scope
            <select className={`${input} w-64`} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="account">Account (all listings)</option>
              {groups.length > 0 && (
                <optgroup label="Group customizations">
                  {groups.map((g) => (
                    <option key={g} value={`group:${g}`}>
                      Group: {g}
                    </option>
                  ))}
                </optgroup>
              )}
              {units.length > 0 && (
                <optgroup label="Listings">
                  {units.map((u) => (
                    <option key={u.id} value={`unit:${u.id}`}>
                      {u.name} — {u.neighborhood}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <span className="pb-1 text-[10px] text-muted-foreground/70">
            Saving writes every section below to {scopeLabel}; Reset clears the scope so it inherits again.
          </span>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {toggle("Seasonality", "seasonalityOn")}
          {toggle("Demand / events", "demandOn")}
          {toggle("Booking pace", "pacingOn")}
          {toggle("Occupancy bands", "occupancyOn")}
          {toggle("Far-out premium", "farOutOn")}
          {toggle("Last-minute discount", "lastMinuteOn")}
          {toggle("Adjacent factor", "adjacentOn")}
          {toggle("Orphan day prices", "orphanOn")}
          {toggle("Portfolio occupancy", "pobaOn")}
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
          {num("Headline lead days", "currentRateLeadDays")}
          {num("Human gate ±%", "humanGatePct")}
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Weekend days — which nights count as weekend for orphan / min-stay / min-price splits
          </span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {DOW.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={f.weekendDays[i]}
                  onChange={(e) => {
                    const days = [...f.weekendDays];
                    days[i] = e.target.checked;
                    set("weekendDays", days);
                  }}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                {d}
              </label>
            ))}
          </div>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Adjacent factor — open days around bookings (discount fills gaps, premium discourages
            back-to-back turnovers; largest discount wins vs last-minute/orphan, premiums stack)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Type", "adjacentMode", [
              { value: "percent", label: "Percent" },
              { value: "fixed", label: "Fixed (₪)" },
            ], "w-28")}
            {num(f.adjacentMode === "fixed" ? "Value ₪ (− disc / + prem)" : "Value % (− disc / + prem)", "adjacentValue", "w-28")}
            {num("Days before booking", "adjacentBefore")}
            {num("Days after booking", "adjacentAfter")}
            {toggle("Also apply on weekends", "adjacentWeekends")}
          </div>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Orphan day prices — adjust short open gaps between bookings (up to 3 ranges, ascending
            gap length; % joins the discount stack, fixed ₪ pins the nightly price)
          </span>
          {f.orphanRanges.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-10 text-[10px]">#{i + 1}</span>
              gap ≤ {cell("orphanRanges", i, "upTo", r.upTo, "w-14")} nights ·
              <select
                className={`${input} w-24`}
                value={r.mode}
                onChange={(e) => setRow<OrphanRow>("orphanRanges", i, "mode", e.target.value)}
              >
                <option value="percent">Percent</option>
                <option value="fixed">Fixed ₪</option>
              </select>
              weekday {cell("orphanRanges", i, "weekday", r.weekday)} weekend{" "}
              {cell("orphanRanges", i, "weekend", r.weekend)} · within{" "}
              {cell("orphanRanges", i, "withinDays", r.withinDays, "w-14")} d (blank = always)
            </div>
          ))}
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Portfolio occupancy-based adjustments — price each date off the COMBINED occupancy of
            the listing&apos;s customization group (needs groups; pre-clamp, so min/max still hold)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Profile", "pobaProfile", [
              { value: "short", label: "Short booking window" },
              { value: "medium", label: "Medium booking window" },
              { value: "long", label: "Long booking window" },
              { value: "custom", label: "Custom" },
            ], "w-48")}
          </div>
          {f.pobaProfile === "custom" && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-muted-foreground/70">
                Per window: adjustment % at &lt;50% / 50–80% / 80–95% / 95%+ group occupancy
                (−50..+500, ascending with occupancy)
              </div>
              {f.pobaWindows.map((w, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  ≤ {cell("pobaWindows", i, "uptoDays", w.uptoDays, "w-16")} d out:
                  {cell("pobaWindows", i, "soft", w.soft, "w-14")}
                  {cell("pobaWindows", i, "healthy", w.healthy, "w-14")}
                  {cell("pobaWindows", i, "tight", w.tight, "w-14")}
                  {cell("pobaWindows", i, "full", w.full, "w-14")} %
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Advanced minimum prices — far-out/weekend floors only RAISE the listing min; last-minute
            and orphan floors REPLACE it (and may sit below it)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Far-out min", "mpFarOutOn")}
            {num("≥ days out", "mpFarOutDays", "w-16")}
            {select("", "mpFarOutMode", MIN_PRICE_MODES, "w-28")}
            {num("Value", "mpFarOutValue", "w-20")}
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Weekend min", "mpWeekendOn")}
            {select("", "mpWeekendMode", MIN_PRICE_MODES, "w-28")}
            {num("Value", "mpWeekendValue", "w-20")}
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Last-minute min", "mpLastMinOn")}
            {num("≤ days out", "mpLastMinDays", "w-16")}
            {select("", "mpLastMinMode", MIN_PRICE_MODES, "w-28")}
            {num("Value", "mpLastMinValue", "w-20")}
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Orphan-day min", "mpOrphanOn")}
            {select("", "mpOrphanMode", MIN_PRICE_MODES, "w-28")}
            {num("Value", "mpOrphanValue", "w-20")}
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            % values are signed changes (e.g. −20 = 20% below base/min). Per-date minimums for
            events live in the Rates Calendar&apos;s Date Specific Overrides.
          </p>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Minimum-stay rules — hierarchy: lowest-allowed → orphan gap → date override → adjacent
            after/before → far-out → last-minute → default (MiniHotel MinimumNights = min-stay-through)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Mode", "msMode", [
              { value: "recommended", label: "PriceLabs-style Recommended (dynamic)" },
              { value: "custom", label: "Custom rules" },
            ], "w-64")}
            {num("Highest allowed n", "msHighest")}
            {num("Far-out ≥ d", "minStayFarOutDays")}
            {num("Far-out nights", "minStayFarOutNights")}
            {toggle("Adaptive occupancy (−1/−2 n below market)", "msAdaptiveOn")}
          </div>
          {f.msMode === "custom" && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              {select("Default rule", "msRule", [
                { value: "fixed", label: "Fixed (weekday/weekend)" },
                { value: "bookingValue", label: "Booking value (₪)" },
              ], "w-48")}
              {f.msRule === "bookingValue"
                ? num("Min booking value ₪", "msBookingValue", "w-24")
                : (
                  <>
                    {num("Weekday n", "msWeekday")}
                    {num("Weekend n", "msWeekend")}
                  </>
                )}
            </div>
          )}
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground/70">
              Last-minute min-stay rules (up to 3; blank window = unused)
            </div>
            {f.msLm.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                within {cell("msLm", i, "withinDays", r.withinDays, "w-14")} d → weekday{" "}
                {cell("msLm", i, "weekday", r.weekday, "w-14")} n, weekend{" "}
                {cell("msLm", i, "weekend", r.weekend, "w-14")} n
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Adjacent-day min stays", "msAdjOn")}
            {num("After a checkout: n", "msAdjAfter")}
            {toggle("Before a booking: allow flush-fit stays", "msAdjBeforeFlush")}
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Orphan-gap min stay (only ever reduces)", "msOrphanOn")}
            {select("Strategy", "msOrphanStrategy", [
              { value: "lengthOfGap", label: "Length of gap" },
              { value: "gapMinus1", label: "Length of gap − 1" },
              { value: "gapMinus2", label: "Length of gap − 2" },
              { value: "fixed", label: "Fixed number" },
            ], "w-44")}
            {f.msOrphanStrategy === "fixed" && num("Fixed n", "msOrphanFixed", "w-14")}
            {num("Max gap n", "msOrphanMaxGap", "w-14")}
            {num("Lowest orphan n", "msOrphanLowest", "w-14")}
          </div>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Pricing offset — applied after every other rule, the min/max clamp and fixed overrides
            (can push the final rate outside the unit&apos;s floor/ceiling; discount caps at 40,
            premium at 500)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Type", "offsetMode", [
              { value: "percent", label: "Percent" },
              { value: "fixed", label: "Fixed (₪)" },
            ], "w-28")}
            {num(f.offsetMode === "fixed" ? "Value ₪ (− disc / + prem)" : "Value % (− disc / + prem)", "offsetValue", "w-28")}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={save} className={btn}>
            {saved ? "Saved ✓" : `Save to ${scope === "account" ? "account" : scopeLabel}`}
          </button>
          <button type="button" disabled={busy} onClick={resetScope} className={btnGhost}>
            Reset scope
          </button>
          <span className="text-[10px] text-muted-foreground/70">
            Per-unit floor/ceiling &amp; monthly discounts live on the units themselves. Removing a
            restriction never retracts it from MiniHotel by itself — clearing overrides re-pushes
            the defaults in the same action (Rates Calendar → Date Specific Overrides).
          </span>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <span className="text-xs font-medium text-foreground">Customization groups</span>
          <div className="flex flex-wrap items-center gap-2">
            {groupInfo.map((g) => (
              <span key={g.name} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
                <span className="font-medium text-foreground">{g.name}</span>
                <span className="text-[10px]">
                  {g.members} listing(s){g.asSubgroup > 0 ? ` · ${g.asSubgroup} as sub` : ""}
                  {g.occ30 != null ? ` · ${(g.occ30 * 100).toFixed(0)}% occ 30d` : ""}
                </span>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-[hsl(var(--danger))]"
                  title="Delete group (detaches listings)"
                  onClick={() => groupsAction({ delete: g.name })}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              className={`${input} w-40`}
              placeholder="New group name"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
            />
            <button
              type="button"
              className={btnGhost}
              disabled={busy || !newGroup.trim()}
              onClick={() => {
                groupsAction({ create: newGroup.trim() });
                setNewGroup("");
              }}
            >
              Create group
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <label className="flex flex-col gap-1">
              Assign group
              <select className={`${input} w-40`} value={assignGroup} onChange={(e) => setAssignGroup(e.target.value)}>
                <option value="">— no group —</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Sub-group (optional)
              <select className={`${input} w-40`} value={assignSub} onChange={(e) => setAssignSub(e.target.value)}>
                <option value="">— none —</option>
                {groups
                  .filter((g) => g !== assignGroup)
                  .map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className={btn}
              disabled={busy || picked.size === 0}
              onClick={() =>
                groupsAction({
                  assign: {
                    unitIds: [...picked],
                    group: assignGroup || null,
                    subgroup: assignSub || null,
                  },
                }).then(() => setPicked(new Set()))
              }
            >
              Assign {picked.size || ""} selected
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-border/60 p-2">
            {units.map((u) => (
              <label key={u.id} className="flex items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={picked.has(u.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    setPicked(next);
                  }}
                />
                <span className="text-foreground">{u.name}</span>
                <span className="text-[10px]">— {u.neighborhood}</span>
                {(u.group || u.subgroup) && (
                  <span className="text-[10px] text-primary">
                    {u.group ?? ""}
                    {u.subgroup ? ` / ${u.subgroup}` : ""}
                  </span>
                )}
              </label>
            ))}
          </div>
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
                  <Line type="monotone" dataKey="defaults" name="Default customizations" stroke="#334155" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="current" name="Current (saved)" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="6 4" dot={false} />
                  <Line type="monotone" dataKey="candidate" name="Edited (unsaved)" stroke="#2563eb" strokeWidth={2} dot={false} />
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
                Red dashed = saved rules today · blue = these edits saved to {scopeLabel} (not saved
                yet) · dark = code-default customizations only · green dots = nights already booked.
                Previewing a scope the listing doesn&apos;t belong to shows no effect — same as a
                real save. Nothing is applied until you click Save.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
