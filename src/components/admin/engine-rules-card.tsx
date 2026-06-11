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
const FLAVORS = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
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
  demandSens: string;
  demandCapPct: string;
  smpOn: boolean;
  smpPct: string;
  pacingOn: boolean;
  pacingSensPct: string;
  pacingCapPct: string;
  occupancyOn: boolean;
  farOutOn: boolean;
  farOutMode: string;
  farOutFlavor: string;
  farOutDays: string;
  farOutCapPct: string;
  farOutRampDays: string;
  lastMinuteOn: boolean;
  lastMinMode: string;
  lastMinFlavor: string;
  lastMinWindow: string;
  lastMinValue: string;
  adjacentOn: boolean;
  adjacentMode: string;
  adjacentValue: string;
  adjacentBefore: string;
  adjacentAfter: string;
  adjacentWeekends: boolean;
  dayOfWeekOn: boolean;
  losOn: boolean;
  losWeekly: string;
  losMonthly: string;
  losQuarterNights: string;
  losQuarterPct: string;
  epfOn: boolean;
  epfMode: string;
  epfValue: string;
  epfAfter: string;
  cicoOn: boolean;
  cicoProfile: string;
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
  demandEvents: { enabled: boolean; sensitivity: string; cap: number };
  safetyMinPrice: { enabled: boolean; pctOfLastYear: number };
  pacing: { enabled: boolean; sensitivity: number; cap: number };
  occupancy: { enabled: boolean };
  farOut: {
    enabled: boolean;
    mode: string;
    marketFlavor: string;
    thresholdDays: number;
    cap: number;
    rampDays: number;
  };
  lastMinute: { enabled: boolean; mode: string; marketFlavor: string; windowDays: number; value: number };
  adjacent: {
    enabled: boolean;
    mode: "percent" | "fixed";
    value: number;
    daysBefore: number;
    daysAfter: number;
    applyOnWeekends: boolean;
  };
  dayOfWeek: { enabled: boolean };
  los: {
    enabled: boolean;
    weeklyPct: number | null;
    monthlyPct: number | null;
    quarterlyMinNights: number;
    quarterlyDiscountPct: number;
  };
  extraPersonFee: { enabled: boolean; mode: string; value: number; afterGuests: number };
  checkinCheckout: { enabled: boolean; profile: string | null };
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

interface CicoProfile {
  name: string;
  archived: boolean;
  allowedCheckin: number[];
  allowedCheckout: number[];
}

interface WizardSuggestion {
  name: string;
  unitIds: string[];
  alreadyGrouped: string[];
}

interface TableResp {
  sections: Array<{ key: string; label: string }>;
  rows: Array<{
    unitId: string;
    name: string;
    neighborhood: string;
    group: string | null;
    subgroup: string | null;
    sources: Record<string, string | null>;
  }>;
}

const SOURCE_COLOR: Record<string, string> = {
  listing: "#16a34a",
  subgroup: "#7c3aed",
  group: "#2563eb",
  account: "#d97706",
};
const sourceKind = (s: string | null) => (s ? s.split(":")[0] : "default");

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
    demandSens: e.demandEvents.sensitivity || "recommended",
    demandCapPct: pct(e.demandEvents.cap),
    smpOn: e.safetyMinPrice.enabled,
    smpPct: pct(e.safetyMinPrice.pctOfLastYear),
    pacingOn: e.pacing.enabled,
    pacingSensPct: pct(e.pacing.sensitivity),
    pacingCapPct: pct(e.pacing.cap),
    occupancyOn: e.occupancy.enabled,
    farOutOn: e.farOut.enabled,
    farOutMode: e.farOut.mode || "gradual",
    farOutFlavor: e.farOut.marketFlavor || "balanced",
    farOutDays: String(e.farOut.thresholdDays),
    farOutCapPct: pct(e.farOut.cap),
    farOutRampDays: String(e.farOut.rampDays),
    lastMinuteOn: e.lastMinute.enabled,
    lastMinMode: e.lastMinute.mode || "gradual",
    lastMinFlavor: e.lastMinute.marketFlavor || "balanced",
    lastMinWindow: String(e.lastMinute.windowDays),
    lastMinValue: e.lastMinute.mode === "fixed" ? String(e.lastMinute.value) : pct(e.lastMinute.value),
    adjacentOn: e.adjacent.enabled,
    adjacentMode: e.adjacent.mode,
    adjacentValue: e.adjacent.mode === "percent" ? pct(e.adjacent.value) : String(e.adjacent.value),
    adjacentBefore: String(e.adjacent.daysBefore),
    adjacentAfter: String(e.adjacent.daysAfter),
    adjacentWeekends: e.adjacent.applyOnWeekends,
    dayOfWeekOn: e.dayOfWeek.enabled,
    losOn: e.los.enabled,
    losWeekly: e.los.weeklyPct == null ? "" : pct(e.los.weeklyPct),
    losMonthly: e.los.monthlyPct == null ? "" : pct(e.los.monthlyPct),
    losQuarterNights: String(e.los.quarterlyMinNights),
    losQuarterPct: pct(e.los.quarterlyDiscountPct),
    epfOn: e.extraPersonFee.enabled,
    epfMode: e.extraPersonFee.mode || "fixed",
    epfValue:
      e.extraPersonFee.mode === "percent" ? pct(e.extraPersonFee.value) : String(e.extraPersonFee.value),
    epfAfter: String(e.extraPersonFee.afterGuests),
    cicoOn: e.checkinCheckout.enabled,
    cicoProfile: e.checkinCheckout.profile ?? "",
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

  // Group Creation Wizard state
  const [wizStrategy, setWizStrategy] = useState("city_bedroom");
  const [wizSuggestions, setWizSuggestions] = useState<WizardSuggestion[] | null>(null);
  const [wizPicked, setWizPicked] = useState<Set<string>>(new Set());
  const [wizNames, setWizNames] = useState<Record<string, string>>({});

  // Table View state
  const [tableData, setTableData] = useState<TableResp | null>(null);
  const [tableBusy, setTableBusy] = useState(false);

  // Check-in/Check-out profiles state
  const [cicoProfiles, setCicoProfiles] = useState<CicoProfile[]>([]);
  const [cicoArchivedShown, setCicoArchivedShown] = useState(false);
  const [edName, setEdName] = useState("");
  const [edCheckin, setEdCheckin] = useState<boolean[]>(Array(7).fill(true));
  const [edCheckout, setEdCheckout] = useState<boolean[]>(Array(7).fill(true));

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

  const loadProfiles = useCallback(async (archived: boolean) => {
    const res = await fetch(`/api/pricing/profiles${archived ? "?archived=1" : ""}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const b = (await res.json()) as { cico: CicoProfile[] };
    setCicoProfiles(b.cico);
  }, []);
  useEffect(() => {
    loadProfiles(cicoArchivedShown).catch(() => undefined);
  }, [loadProfiles, cicoArchivedShown]);

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
      demandEvents: { enabled: f.demandOn, sensitivity: f.demandSens, cap: frac(f.demandCapPct) },
      safetyMinPrice: { enabled: f.smpOn, pctOfLastYear: frac(f.smpPct) },
      pacing: { enabled: f.pacingOn, sensitivity: frac(f.pacingSensPct), cap: frac(f.pacingCapPct) },
      occupancy: { enabled: f.occupancyOn },
      farOut: {
        enabled: f.farOutOn,
        mode: f.farOutMode,
        marketFlavor: f.farOutFlavor,
        thresholdDays: int(f.farOutDays),
        cap: frac(f.farOutCapPct),
        rampDays: int(f.farOutRampDays, 1),
      },
      lastMinute: {
        enabled: f.lastMinuteOn,
        mode: f.lastMinMode,
        marketFlavor: f.lastMinFlavor,
        windowDays: int(f.lastMinWindow),
        value: f.lastMinMode === "fixed" ? parseFloat(f.lastMinValue) || 0 : frac(f.lastMinValue),
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
        weeklyPct: f.losWeekly.trim() === "" ? null : Math.abs(frac(f.losWeekly)),
        monthlyPct: f.losMonthly.trim() === "" ? null : Math.abs(frac(f.losMonthly)),
        quarterlyMinNights: int(f.losQuarterNights, 90),
        quarterlyDiscountPct: frac(f.losQuarterPct),
      },
      extraPersonFee: {
        enabled: f.epfOn,
        mode: f.epfMode === "percent" ? "percent" : "fixed",
        value: f.epfMode === "percent" ? frac(f.epfValue) : parseFloat(f.epfValue) || 0,
        afterGuests: int(f.epfAfter, 2),
      },
      checkinCheckout: {
        enabled: f.cicoOn,
        profile: f.cicoProfile || null,
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

  function pickProfileToEdit(name: string) {
    const p = cicoProfiles.find((x) => x.name === name);
    if (!p) return;
    setEdName(p.name);
    setEdCheckin(DOW.map((_, i) => p.allowedCheckin.includes(i)));
    setEdCheckout(DOW.map((_, i) => p.allowedCheckout.includes(i)));
  }

  async function profilesAction(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error || `request failed: ${res.status}`);
      }
      await loadProfiles(cicoArchivedShown);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "profile update failed");
    } finally {
      setBusy(false);
    }
  }

  async function wizardSuggest() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/pricing/groups?wizard=${wizStrategy}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`wizard failed: ${res.status}`);
      const b = (await res.json()) as { suggestions: WizardSuggestion[] };
      setWizSuggestions(b.suggestions);
      setWizPicked(new Set(b.suggestions.filter((s) => s.unitIds.length > s.alreadyGrouped.length).map((s) => s.name)));
      setWizNames({});
    } catch (e) {
      setErr(e instanceof Error ? e.message : "wizard failed");
    } finally {
      setBusy(false);
    }
  }

  async function wizardApply() {
    if (!wizSuggestions) return;
    const apply = wizSuggestions
      .filter((s) => wizPicked.has(s.name))
      .map((s) => ({ name: (wizNames[s.name] ?? s.name).trim() || s.name, unitIds: s.unitIds }));
    if (apply.length === 0) return;
    await groupsAction({ wizard: apply });
    setWizSuggestions(null);
  }

  async function loadTable() {
    setTableBusy(true);
    try {
      const res = await fetch("/api/pricing/rules/table", { cache: "no-store" });
      if (res.ok) setTableData((await res.json()) as TableResp);
    } finally {
      setTableBusy(false);
    }
  }

  function downloadTableCsv() {
    if (!tableData) return;
    const head = ["listing", "neighborhood", "group", "subgroup", ...tableData.sections.map((s) => s.label)];
    const lines = [head.join(",")];
    for (const r of tableData.rows) {
      lines.push(
        [
          `"${r.name}"`,
          `"${r.neighborhood}"`,
          r.group ?? "",
          r.subgroup ?? "",
          ...tableData.sections.map((s) => r.sources[s.key] ?? "default"),
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "customizations-table.csv";
    a.click();
    URL.revokeObjectURL(a.href);
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
          {select("Demand factor sensitivity", "demandSens", SENS_OPTIONS)}
          {num("Demand cap %", "demandCapPct")}
          {num("Pace sensitivity %", "pacingSensPct")}
          {num("Pace cap %", "pacingCapPct")}
          {num("Weekly disc % (blank = unit)", "losWeekly")}
          {num("Monthly disc % (blank = unit)", "losMonthly")}
          {num("Quarter ≥ nights", "losQuarterNights")}
          {num("Quarter disc %", "losQuarterPct")}
          {num("Headline lead days", "currentRateLeadDays")}
          {num("Human gate ±%", "humanGatePct")}
        </div>
        <p className="text-[10px] text-muted-foreground/70">
          Weekly/monthly discounts: 0–75% (PriceLabs range), no sign needed; they apply on top of
          nightly rates, so the effective stay rate can dip below the minimum price. Quote-side
          only — MiniHotel isn&apos;t in PriceLabs&apos;s weekly/monthly push list, so set any
          PMS-side discount there.
        </p>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Far-out prices — hold/raise distant dates (market-driven: capped at 20%, never before
            60 days out)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Mode", "farOutMode", [
              { value: "gradual", label: "% Gradual" },
              { value: "flat", label: "% Flat" },
              { value: "marketDriven", label: "Market driven" },
            ], "w-36")}
            {f.farOutMode === "marketDriven"
              ? select("Flavor", "farOutFlavor", FLAVORS, "w-36")
              : (
                <>
                  {num("≥ days out", "farOutDays")}
                  {num("Cap % (− disc / + prem)", "farOutCapPct", "w-28")}
                  {f.farOutMode === "gradual" && num("Ramp days", "farOutRampDays")}
                </>
              )}
          </div>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Last-minute prices — fine-tune near-arrival rates (custom windows max 90 days; a fixed
            ₪ price pins the night and beats an orphan-day fixed price)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {select("Mode", "lastMinMode", [
              { value: "gradual", label: "% Gradual" },
              { value: "flat", label: "% Flat" },
              { value: "fixed", label: "Fixed ₪" },
              { value: "marketDriven", label: "Market driven" },
            ], "w-36")}
            {num("Window ≤ days", "lastMinWindow")}
            {f.lastMinMode === "marketDriven"
              ? select("Flavor", "lastMinFlavor", FLAVORS, "w-36")
              : num(f.lastMinMode === "fixed" ? "Price ₪" : "Value % (− disc / + prem)", "lastMinValue", "w-28")}
          </div>
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
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-border/40 pt-2">
            {toggle("Safety minimum price", "smpOn")}
            {num("% of last year", "smpPct", "w-20")}
            <span className="pb-1 text-[10px] text-muted-foreground/70">
              Floors each night at last year&apos;s realized same-weekday rate (STLY ±1 week,
              weighted; event dates take the max) × this factor — 110% is the safe choice.
              Raises-only, never below the listing min; inert until MiniHotel reservation history
              covers the dates.
            </span>
          </div>
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
            Extra person fee — per extra guest per night above the threshold (percent mode prices
            off the check-in day&apos;s rate only, as PriceLabs sends no per-night variation)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Charge extra person fee", "epfOn")}
            {select("Type", "epfMode", [
              { value: "fixed", label: "Fixed ₪" },
              { value: "percent", label: "% of nightly rate" },
            ], "w-36")}
            {num(f.epfMode === "percent" ? "Value %" : "Value ₪", "epfValue", "w-20")}
            {num("After guests", "epfAfter", "w-16")}
          </div>
        </div>

        <div className={sectionBox}>
          <span className={sectionHead}>
            Check-in / Check-out — named profiles of allowed weekdays, attachable per scope
            (all-or-nothing per level; engine-side flags — MiniHotel&apos;s Reverse ARI has no
            verified CTA/CTD field, so this is not pushed)
          </span>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {toggle("Restrict check-in/check-out", "cicoOn")}
            <label className="flex flex-col gap-1">
              Attached profile
              <select
                className={`${input} w-44`}
                value={f.cicoProfile}
                onChange={(e) => set("cicoProfile", e.target.value)}
              >
                <option value="">— none —</option>
                {cicoProfiles
                  .filter((p) => !p.archived || p.name === f.cicoProfile)
                  .map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.archived ? " (archived — still applies)" : ""}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="space-y-2 rounded-md border border-border/40 p-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                Profile editor
                <input
                  className={`${input} w-40`}
                  placeholder="Profile name"
                  value={edName}
                  onChange={(e) => setEdName(e.target.value)}
                />
              </label>
              <select className={`${input} w-44`} value="" onChange={(e) => pickProfileToEdit(e.target.value)}>
                <option value="">Load existing…</option>
                {cicoProfiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.archived ? " (archived)" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btnGhost}
                disabled={busy || !edName.trim()}
                onClick={() =>
                  profilesAction({
                    save: {
                      name: edName.trim(),
                      allowedCheckin: edCheckin.flatMap((on, i) => (on ? [i] : [])),
                      allowedCheckout: edCheckout.flatMap((on, i) => (on ? [i] : [])),
                    },
                  })
                }
              >
                Save profile
              </button>
              {cicoProfiles.some((p) => p.name === edName.trim()) && (
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => {
                    const p = cicoProfiles.find((x) => x.name === edName.trim());
                    profilesAction(p?.archived ? { unarchive: p.name } : { archive: edName.trim() });
                  }}
                >
                  {cicoProfiles.find((x) => x.name === edName.trim())?.archived ? "Unarchive" : "Archive"}
                </button>
              )}
              <label className="inline-flex items-center gap-1.5 pb-1.5">
                <input
                  type="checkbox"
                  checked={cicoArchivedShown}
                  onChange={(e) => setCicoArchivedShown(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                Show archived
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-20 text-[10px]">Check-in on</span>
              {DOW.map((d, i) => (
                <label key={`ci-${d}`} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={edCheckin[i]}
                    onChange={(e) => {
                      const days = [...edCheckin];
                      days[i] = e.target.checked;
                      setEdCheckin(days);
                    }}
                    className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  />
                  {d}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-20 text-[10px]">Check-out on</span>
              {DOW.map((d, i) => (
                <label key={`co-${d}`} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={edCheckout[i]}
                    onChange={(e) => {
                      const days = [...edCheckout];
                      days[i] = e.target.checked;
                      setEdCheckout(days);
                    }}
                    className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  />
                  {d}
                </label>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/70">
              Profiles can&apos;t be deleted — archive instead. Removal semantics still apply: detach
              + push before disabling, or the last pushed restriction lingers on the PMS.
            </p>
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
          <div className="space-y-2 rounded-md border border-border/40 p-2">
            <div className="flex flex-wrap items-end gap-2">
              <span className="w-full text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                Group Creation Wizard — suggests groups from listing attributes; nothing is applied
                until you confirm (already-grouped listings are never moved)
              </span>
              <label className="flex flex-col gap-1">
                Strategy
                <select
                  className={`${input} w-44`}
                  value={wizStrategy}
                  onChange={(e) => setWizStrategy(e.target.value)}
                >
                  <option value="city_bedroom">City + Bedroom (default)</option>
                  <option value="city">City</option>
                  <option value="bedroom">Bedroom</option>
                </select>
              </label>
              <button type="button" className={btnGhost} disabled={busy} onClick={wizardSuggest}>
                Suggest groups
              </button>
              {wizSuggestions && (
                <button type="button" className={btn} disabled={busy || wizPicked.size === 0} onClick={wizardApply}>
                  Create &amp; assign {wizPicked.size} group(s)
                </button>
              )}
            </div>
            {wizSuggestions && wizSuggestions.length === 0 && (
              <p className="text-[10px] text-muted-foreground/70">No buckets with 2+ listings found.</p>
            )}
            {wizSuggestions && wizSuggestions.length > 0 && (
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {wizSuggestions.map((s) => {
                  const free = s.unitIds.length - s.alreadyGrouped.length;
                  return (
                    <div key={s.name} className="flex flex-wrap items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                        checked={wizPicked.has(s.name)}
                        onChange={(e) => {
                          const next = new Set(wizPicked);
                          if (e.target.checked) next.add(s.name);
                          else next.delete(s.name);
                          setWizPicked(next);
                        }}
                      />
                      <input
                        className={`${input} w-48`}
                        value={wizNames[s.name] ?? s.name}
                        onChange={(e) => setWizNames({ ...wizNames, [s.name]: e.target.value })}
                      />
                      <span className="text-[10px]">
                        {free} assignable
                        {s.alreadyGrouped.length > 0 ? ` · ${s.alreadyGrouped.length} already grouped` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <details className="space-y-2 border-t border-border/60 pt-3">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Table view — which level supplies each customization (hierarchy at a glance)
          </summary>
          <div className="flex items-center gap-2 pt-2">
            <button type="button" className={btnGhost} disabled={tableBusy} onClick={loadTable}>
              {tableBusy ? "Loading…" : tableData ? "Refresh" : "Load table"}
            </button>
            {tableData && (
              <button type="button" className={btnGhost} onClick={downloadTableCsv}>
                Download CSV
              </button>
            )}
            <span className="text-[10px] text-muted-foreground/70">
              <span style={{ color: SOURCE_COLOR.listing }}>●</span> listing ·{" "}
              <span style={{ color: SOURCE_COLOR.subgroup }}>●</span> sub-group ·{" "}
              <span style={{ color: SOURCE_COLOR.group }}>●</span> group ·{" "}
              <span style={{ color: SOURCE_COLOR.account }}>●</span> account · ○ code default —
              hover a dot for the level
            </span>
          </div>
          {tableData && (
            <div className="max-h-80 overflow-auto rounded-md border border-border/60">
              <table className="w-full border-collapse text-[10px]">
                <thead className="sticky top-0 bg-card">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Listing</th>
                    {tableData.sections.map((s) => (
                      <th key={s.key} className="px-1 py-1 text-center font-medium" title={s.key}>
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.rows.map((r) => (
                    <tr key={r.unitId} className="border-t border-border/40">
                      <td className="whitespace-nowrap px-2 py-0.5">
                        {r.name}
                        {(r.group || r.subgroup) && (
                          <span className="text-muted-foreground/70"> · {r.group ?? ""}{r.subgroup ? ` / ${r.subgroup}` : ""}</span>
                        )}
                      </td>
                      {tableData.sections.map((s) => {
                        const src = r.sources[s.key];
                        const kind = sourceKind(src);
                        return (
                          <td key={s.key} className="px-1 py-0.5 text-center" title={src ?? "code default"}>
                            {src ? (
                              <span style={{ color: SOURCE_COLOR[kind] ?? "#64748b" }}>●</span>
                            ) : (
                              <span className="text-muted-foreground/40">○</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>

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
