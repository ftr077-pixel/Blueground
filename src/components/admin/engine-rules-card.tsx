"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

// Form state mirrors the API's effective config; percents shown as % (stored as
// fractions server-side where noted).
interface Form {
  seasonalityOn: boolean;
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
  dayOfWeekOn: boolean;
  losOn: boolean;
  losQuarterNights: string;
  losQuarterPct: string;
  minStayFarOutDays: string;
  minStayFarOutNights: string;
  currentRateLeadDays: string;
  humanGatePct: string;
}

interface EffectiveResp {
  effective: {
    currentRateLeadDays: number;
    seasonality: { enabled: boolean };
    demandEvents: { enabled: boolean; cap: number };
    pacing: { enabled: boolean; sensitivity: number; cap: number };
    occupancy: { enabled: boolean };
    farOut: { enabled: boolean; thresholdDays: number; cap: number; rampDays: number };
    lastMinute: { enabled: boolean; windowDays: number; maxDiscount: number };
    dayOfWeek: { enabled: boolean };
    los: { enabled: boolean; quarterlyMinNights: number; quarterlyDiscountPct: number };
    minStayHierarchy: { farOutThresholdDays: number; farOutNights: number };
    humanGatePct: number;
  };
}

const pct = (f: number) => String(Math.round(f * 1000) / 10);
const frac = (s: string) => (parseFloat(s) || 0) / 100;

function toForm(e: EffectiveResp["effective"]): Form {
  return {
    seasonalityOn: e.seasonality.enabled,
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
    dayOfWeekOn: e.dayOfWeek.enabled,
    losOn: e.los.enabled,
    losQuarterNights: String(e.los.quarterlyMinNights),
    losQuarterPct: pct(e.los.quarterlyDiscountPct),
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

  async function load() {
    const res = await fetch("/api/pricing/rules", { cache: "no-store" });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const b = (await res.json()) as EffectiveResp;
    setF(toForm(b.effective));
  }

  useEffect(() => {
    load().catch((e) => setErr(e instanceof Error ? e.message : "failed to load"));
  }, []);

  if (err) return <p className="text-[11px] text-[hsl(var(--danger))]">{err}</p>;
  if (!f) return null;

  const set = (k: keyof Form, v: string | boolean) => setF((c) => (c ? { ...c, [k]: v } : c));

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

  async function save() {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/pricing/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentRateLeadDays: parseInt(f.currentRateLeadDays, 10) || 0,
          humanGatePct: parseFloat(f.humanGatePct) || 15,
          seasonality: { enabled: f.seasonalityOn },
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
          dayOfWeek: { enabled: f.dayOfWeekOn },
          los: {
            enabled: f.losOn,
            quarterlyMinNights: parseInt(f.losQuarterNights, 10) || 90,
            quarterlyDiscountPct: frac(f.losQuarterPct),
          },
          minStayHierarchy: {
            farOutThresholdDays: parseInt(f.minStayFarOutDays, 10) || 90,
            farOutNights: parseInt(f.minStayFarOutNights, 10) || 60,
          },
        }),
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

  return (
    <Card id="engine-rules">
      <CardHeader className="pb-3">
        <CardTitle>Pricing engine rules</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The rule stack behind the Pricing Engine tab (base × seasonality × demand × pace ×
          occupancy × lead-time, clamped to each unit&apos;s floor/ceiling). Changes apply on the
          next pricing pass — no redeploy. Last-minute and day-of-week ship off: they&apos;re
          short-stay mechanics that rarely fit 30+ night rentals.
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
          {toggle("Day-of-week", "dayOfWeekOn")}
          {toggle("LOS / quarter discount", "losOn")}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
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
            Per-unit floor/ceiling &amp; monthly discounts live on the units themselves; occupancy
            band cutoffs and the seasonality curve are code-level (the curve is market-driven once
            AirROI is live).
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
