"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

export function CostDefaultsCard() {
  const [bgFee, setBgFee] = useState("6");
  const [util, setUtil] = useState("1000");
  const [clean, setClean] = useState("500");
  const [losWk, setLosWk] = useState("0");
  const [losMo, setLosMo] = useState("0");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/visibility/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (s: {
          bgFeePct?: number;
          defaultUtilities?: number;
          defaultCleaning?: number;
          weeklyDiscountPct?: number;
          monthlyDiscountPct?: number;
        }) => {
          if (s.bgFeePct != null) setBgFee(String(s.bgFeePct));
          if (s.defaultUtilities != null) setUtil(String(s.defaultUtilities));
          if (s.defaultCleaning != null) setClean(String(s.defaultCleaning));
          if (s.weeklyDiscountPct != null) setLosWk(String(s.weeklyDiscountPct));
          if (s.monthlyDiscountPct != null) setLosMo(String(s.monthlyDiscountPct));
        },
      )
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    try {
      await fetch("/api/visibility/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bgFeePct: parseFloat(bgFee) || 0,
          defaultUtilities: parseInt(util, 10) || 0,
          defaultCleaning: parseInt(clean, 10) || 0,
          weeklyDiscountPct: parseFloat(losWk) || 0,
          monthlyDiscountPct: parseFloat(losMo) || 0,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Cost defaults</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Used to compute profit in Revenue &amp; Yield. The BG fee is a percentage of gross revenue;
          utilities and cleaning are monthly defaults you can override per listing in Manage. Rent is
          set per property in{" "}
          <Link href="/visibility/manage" className="text-primary hover:underline">
            Manage → Import rent &amp; address
          </Link>
          . Length-of-stay discounts (weekly for 7–27 nights, monthly for 28+) are applied to the
          scraped list price wherever prices show.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
          <label className="flex flex-col gap-1">
            BG fee %
            <input className={`${input} w-24`} value={bgFee} onChange={(e) => setBgFee(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Utilities / mo
            <input className={`${input} w-28`} value={util} onChange={(e) => setUtil(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Cleaning (per stay)
            <input className={`${input} w-28`} value={clean} onChange={(e) => setClean(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Weekly discount %
            <input className={`${input} w-24`} value={losWk} onChange={(e) => setLosWk(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Monthly discount %
            <input className={`${input} w-24`} value={losMo} onChange={(e) => setLosMo(e.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={save} className={btn}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
