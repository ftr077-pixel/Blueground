"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

type Rules = {
  marginLow: string;
  marginHigh: string;
  rankWellPage: string;
  buriedPage: string;
  urgentDays: string;
  relaxedDays: string;
  stepPct: string;
  floorMargin: string;
};

const DEFAULTS: Rules = {
  marginLow: "25",
  marginHigh: "45",
  rankWellPage: "1",
  buriedPage: "5",
  urgentDays: "14",
  relaxedDays: "45",
  stepPct: "5",
  floorMargin: "10",
};

export function PricingRulesCard() {
  const [r, setR] = useState<Rules>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/visibility/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((s: { pricingRules?: Partial<Record<keyof Rules, number>> }) => {
        if (!s.pricingRules) return;
        setR((cur) => {
          const next = { ...cur };
          (Object.keys(cur) as (keyof Rules)[]).forEach((k) => {
            const v = s.pricingRules?.[k];
            if (v != null) next[k] = String(v);
          });
          return next;
        });
      })
      .catch(() => undefined);
  }, []);

  // A plain function (not a component) so inputs keep focus across renders.
  const field = (label: string, k: keyof Rules, hint?: string) => (
    <label key={k} className="flex flex-col gap-1">
      {label}
      <input
        className={`${input} w-24`}
        value={r[k]}
        onChange={(e) => setR((c) => ({ ...c, [k]: e.target.value }))}
      />
      {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  );

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/visibility/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pricingRules: {
            marginLow: parseFloat(r.marginLow) || 0,
            marginHigh: parseFloat(r.marginHigh) || 0,
            rankWellPage: parseInt(r.rankWellPage, 10) || 1,
            buriedPage: parseInt(r.buriedPage, 10) || 1,
            urgentDays: parseInt(r.urgentDays, 10) || 0,
            relaxedDays: parseInt(r.relaxedDays, 10) || 0,
            stepPct: parseFloat(r.stepPct) || 0,
            floorMargin: parseFloat(r.floorMargin) || 0,
          },
        }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Pricing rules</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Drives the ▲ Raise / ▼ Lower / ⚠ Review recommendations on the Search &amp; Profit board.
          <span className="text-foreground"> Raise</span> = ranking well but margin below the low
          mark; <span className="text-foreground">Lower</span> = buried but margin above the high
          mark; <span className="text-foreground">urgency</span> comes from how soon the listing is
          available.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 text-[11px] text-muted-foreground">
          {field("Margin low %", "marginLow", "below = too cheap")}
          {field("Margin high %", "marginHigh", "above = room to cut")}
          {field("Ranks well ≤ page", "rankWellPage")}
          {field("Buried ≥ page", "buriedPage")}
          {field("Urgent ≤ days", "urgentDays")}
          {field("Relaxed ≥ days", "relaxedDays")}
          {field("Suggest step %", "stepPct")}
          {field("Floor margin %", "floorMargin", "never lower below")}
          <button type="button" disabled={busy} onClick={save} className={btn}>
            {saved ? "Saved ✓" : "Save"}
          </button>
          {err && <span className="self-center text-[11px] text-[hsl(var(--danger))]">{err}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
