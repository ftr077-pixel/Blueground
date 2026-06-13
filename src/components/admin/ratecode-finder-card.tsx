"use client";

import { useState } from "react";
import { Check, KeyRound, Loader2, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

type Status = "valid" | "valid-warning" | "wildcard" | "not-defined" | "error";
interface Probe {
  code: string;
  status: Status;
  detail: string;
}
interface WriteProbe {
  code: string;
  writeValid: boolean;
  detail: string;
}

const VARIANT: Record<Status, "success" | "warning" | "info" | "muted" | "danger"> = {
  valid: "success",
  "valid-warning": "warning",
  wildcard: "info",
  "not-defined": "muted",
  error: "danger",
};
const LABEL: Record<Status, string> = {
  valid: "valid",
  "valid-warning": "defined",
  wildcard: "wildcard · read-only",
  "not-defined": "not defined",
  error: "error",
};

export function RateCodeFinderCard() {
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Probe[] | null>(null);
  const [namesSeen, setNamesSeen] = useState<string[]>([]);
  const [fromReservations, setFromReservations] = useState<string[]>([]);
  const [reservationSample, setReservationSample] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedCode, setUsedCode] = useState<string | null>(null);
  const [writeResults, setWriteResults] = useState<WriteProbe[] | null>(null);
  const [writeCell, setWriteCell] = useState<string | null>(null);

  async function discover() {
    setBusy(true);
    setError(null);
    setResults(null);
    setNamesSeen([]);
    setFromReservations([]);
    setReservationSample(null);
    setUsedCode(null);
    setWriteResults(null);
    try {
      const r = await fetch("/api/integrations/minihotel/ratecodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: extra }),
      });
      const d = (await r.json()) as {
        ok: boolean;
        message?: string;
        results?: Probe[];
        namesSeen?: string[];
        fromReservations?: string[];
        reservationSample?: string;
      };
      if (d.ok) {
        setResults(d.results ?? []);
        setNamesSeen(d.namesSeen ?? []);
        setFromReservations(d.fromReservations ?? []);
        setReservationSample(d.reservationSample ?? null);
      } else setError(d.message || "Could not probe rate codes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  // Real write test: does an actual Reverse-ARI no-op write (current price
  // written back) to find which price list ACCEPTS writes. The truthful test.
  async function testWrite() {
    setBusy(true);
    setError(null);
    setWriteResults(null);
    setWriteCell(null);
    setUsedCode(null);
    try {
      const r = await fetch("/api/integrations/minihotel/ratecodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write", candidates: extra }),
      });
      const d = (await r.json()) as {
        ok: boolean;
        message?: string;
        testCell?: string;
        results?: WriteProbe[];
      };
      if (d.ok) {
        setWriteResults(d.results ?? []);
        setWriteCell(d.testCell ?? null);
      } else setError(d.message || "Could not write-test rate codes.");
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
          Note: <span className="font-medium">ALL is a wildcard</span> — it can READ prices but can&apos;t
          store them, so price pushes need the real list name. If no code here shows
          &ldquo;valid&rdquo;, read the exact list name off MiniHotel&apos;s Rates &amp; Availability screen
          (or your PriceLabs channel mapping) and paste it below.
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
            Discover (read)
          </button>
          <button type="button" disabled={busy} onClick={testWrite} className={btn} title="Does a real no-op write to find which price list accepts writes">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Test write
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          <span className="font-medium">Test write</span> is the truthful test for pushing: it writes one
          night&apos;s current price back to MiniHotel under each candidate (a no-op) and reports which the
          PMS accepts. Reads and writes use different code spaces — a code can read-fail yet write-fine
          (e.g. <span className="font-mono">STD</span>).
        </p>

        {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

        {fromReservations.length > 0 && (
          <p className="text-[11px] text-[hsl(var(--success))]">
            Found in your reservations (the real price list your bookings use):{" "}
            <span className="font-mono">{fromReservations.join(", ")}</span> — probed below.
          </p>
        )}
        {namesSeen.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Price-list names mentioned by the feed (auto-probed below):{" "}
            <span className="font-mono text-foreground">{namesSeen.join(", ")}</span>
          </p>
        )}
        {reservationSample && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">
              No rate code found in your reservations — show a raw booking (to spot the field)
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-2 text-[10px]">
              {reservationSample}
            </pre>
          </details>
        )}

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

        {writeResults && (
          <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
            <p className="text-[11px] font-medium text-foreground">
              Write test {writeCell ? <span className="font-normal text-muted-foreground">· tested on {writeCell}</span> : null}
            </p>
            {writeResults.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No codes were write-testable.</p>
            ) : (
              <table className="w-full min-w-[420px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Code</th>
                    <th className="py-2 pr-3 font-medium">Write</th>
                    <th className="py-2 pr-3 font-medium">Detail</th>
                    <th className="py-2 font-medium text-right">Use</th>
                  </tr>
                </thead>
                <tbody>
                  {writeResults.map((p) => (
                    <tr key={p.code} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 font-medium tabular-nums">{p.code}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant={p.writeValid ? "success" : "muted"}>
                          {p.writeValid ? "writes ✓" : "rejected"}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{p.detail}</td>
                      <td className="py-1.5 text-right">
                        {p.writeValid ? (
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
            )}
          </div>
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
