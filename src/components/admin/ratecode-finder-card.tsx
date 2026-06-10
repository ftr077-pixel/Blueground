"use client";

import { useState } from "react";
import { Check, KeyRound, Loader2, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

type Status = "valid" | "valid-warning" | "not-defined" | "error";
interface Probe {
  code: string;
  status: Status;
  detail: string;
}

const VARIANT: Record<Status, "success" | "warning" | "muted" | "danger"> = {
  valid: "success",
  "valid-warning": "warning",
  "not-defined": "muted",
  error: "danger",
};
const LABEL: Record<Status, string> = {
  valid: "valid",
  "valid-warning": "defined",
  "not-defined": "not defined",
  error: "error",
};

export function RateCodeFinderCard() {
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Probe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedCode, setUsedCode] = useState<string | null>(null);

  async function discover() {
    setBusy(true);
    setError(null);
    setResults(null);
    setUsedCode(null);
    try {
      const r = await fetch("/api/integrations/minihotel/ratecodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: extra }),
      });
      const d = (await r.json()) as { ok: boolean; message?: string; results?: Probe[] };
      if (d.ok) setResults(d.results ?? []);
      else setError(d.message || "Could not probe rate codes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  async function useCode(code: string) {
    setBusy(true);
    try {
      await fetch("/api/integrations/minihotel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateCode: code }),
      });
      setUsedCode(code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Find rate code (price list)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          MiniHotel has no &ldquo;list price lists&rdquo; API, so this probes candidate codes against
          ARI and reports which it accepts. Runs against your saved connection (needs a whitelisted IP).
          It can only test codes it&apos;s told to try — for a custom code, check MiniHotel&apos;s
          Rates &amp; Availability screen or what PriceLabs pushes to.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-[11px] text-muted-foreground">
          <label className="flex flex-col gap-1">
            Extra codes to try (optional, comma-separated)
            <input
              className={`${input} w-72`}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="e.g. BG, BLUEGROUND, MAIN-BB"
            />
          </label>
          <button type="button" disabled={busy} onClick={discover} className={btn}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Discover
          </button>
        </div>

        {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

        {results && results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Code</th>
                  <th className="py-2 pr-3 font-medium">Result</th>
                  <th className="py-2 pr-3 font-medium">Detail</th>
                  <th className="py-2 font-medium text-right">Use</th>
                </tr>
              </thead>
              <tbody>
                {results.map((p) => (
                  <tr key={p.code} className="border-b border-border/40">
                    <td className="py-1.5 pr-3 font-medium tabular-nums">{p.code}</td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={VARIANT[p.status]}>{LABEL[p.status]}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{p.detail}</td>
                    <td className="py-1.5 text-right">
                      {p.status === "valid" || p.status === "valid-warning" ? (
                        usedCode === p.code ? (
                          <span className="inline-flex items-center gap-1 text-[hsl(var(--success))]">
                            <Check className="h-3.5 w-3.5" /> set
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => useCode(p.code)}
                            className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
                          >
                            Use
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {results && results.length === 0 && (
          <p className="text-[11px] text-muted-foreground">No candidates were testable.</p>
        )}
        {usedCode && (
          <p className="text-[11px] text-muted-foreground">
            Saved <span className="font-medium">{usedCode}</span> as the rate code. Go to Rates Calendar
            → Sync MiniHotel to pull real prices.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
