"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, ShieldAlert, ShieldCheck, DownloadCloud } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50";

interface View {
  env: "sandbox" | "production";
  username: string;
  hotelId: string;
  rateCode: string;
  hasPassword: boolean;
  vatRate: number; // fraction, e.g. 0.18
  vatCountries: string;
  excludedRoomTypes: string;
  contentUsername: string;
  hasContentPassword: boolean;
  endpoints: { ari: string; reverse: string; content: string };
}

interface ProbeRow {
  ok: boolean;
  detail: string;
}
interface TestResult {
  ok: boolean;
  message?: string;
  ari?: ProbeRow;
  content?: ProbeRow;
}
interface Pull {
  ok: boolean;
  message?: string;
  parsed?: number;
  month?: string;
  net?: number;
  count?: number;
  vat?: number;
  test?: number;
}
interface AriOcc {
  ok: boolean;
  message?: string;
  bookings?: number;
  rooms?: number;
  thisMonth?: string;
  occupancy?: number;
  bookedNights?: number;
}

export function MiniHotelCard() {
  const [env, setEnv] = useState<"sandbox" | "production">("sandbox");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [rateCode, setRateCode] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [vatRate, setVatRate] = useState("18");
  const [vatCountries, setVatCountries] = useState("");
  const [excludedRoomTypes, setExcludedRoomTypes] = useState("");
  const [contentUsername, setContentUsername] = useState("");
  const [contentPassword, setContentPassword] = useState("");
  const [hasContentPassword, setHasContentPassword] = useState(false);
  const [endpoints, setEndpoints] = useState<View["endpoints"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);
  const [ari, setAri] = useState<AriOcc | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const apply = useCallback((v: View) => {
    setEnv(v.env);
    setUsername(v.username);
    setHotelId(v.hotelId);
    setRateCode(v.rateCode);
    setHasPassword(v.hasPassword);
    setVatRate(String(Math.round((v.vatRate ?? 0.18) * 100)));
    setVatCountries(v.vatCountries ?? "");
    setExcludedRoomTypes(v.excludedRoomTypes ?? "");
    setContentUsername(v.contentUsername ?? "");
    setHasContentPassword(!!v.hasContentPassword);
    setEndpoints(v.endpoints);
    setPassword("");
    setContentPassword("");
  }, []);

  const load = useCallback(() => {
    fetch("/api/integrations/minihotel", { cache: "no-store" })
      .then((r) => r.json())
      .then(apply)
      .catch(() => undefined);
  }, [apply]);

  useEffect(() => load(), [load]);

  async function save() {
    setBusy(true);
    setTest(null);
    try {
      const body: {
        env: string;
        username: string;
        hotelId: string;
        rateCode: string;
        vatRate: string;
        vatCountries: string;
        excludedRoomTypes: string;
        contentUsername: string;
        password?: string;
        contentPassword?: string;
      } = {
        env,
        username,
        hotelId,
        rateCode,
        vatRate,
        vatCountries,
        excludedRoomTypes,
        contentUsername,
      };
      if (password) body.password = password;
      if (contentPassword) body.contentPassword = contentPassword;
      const r = await fetch("/api/integrations/minihotel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      apply((await r.json()) as View);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await fetch("/api/integrations/minihotel/test", { method: "POST" });
      setTest((await r.json()) as TestResult);
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : "test failed" });
    } finally {
      setBusy(false);
    }
  }

  // Pull reservations from MiniHotel into the P&L, then read back this month's
  // net. The window is the server's default (~7 months back through ~4 months
  // forward) so every booking still shaping the P&L — including in-house stays
  // that got extended, shortened or re-priced — is re-read, and cancellations
  // are swept. Don't narrow it here: a client-side window silently re-freezes
  // old bookings at their first-captured price.
  async function pullReservations() {
    setBusy(true);
    setPull(null);
    try {
      const sync = await fetch("/api/reservations/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (!sync.ok) {
        setPull({ ok: false, message: sync.message || "sync failed" });
        return;
      }
      const rep = await fetch("/api/reservations", { cache: "no-store" }).then((r) => r.json());
      setPull({
        ok: true,
        parsed: sync.parsed,
        test: sync.test,
        month: rep.thisMonth,
        net: rep.current?.net ?? 0,
        count: rep.current?.count ?? 0,
        vat: rep.current?.vat ?? 0,
      });
    } catch (e) {
      setPull({ ok: false, message: e instanceof Error ? e.message : "pull failed" });
    } finally {
      setBusy(false);
    }
  }

  // Sync occupancy from the ARI server (Room Status) — the bookings that already
  // work — and store them. No revenue (that's Content & Data); occupancy only.
  async function tryAri() {
    setBusy(true);
    setAri(null);
    try {
      const r = await fetch("/api/occupancy/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 45 }),
      }).then((res) => res.json());
      setAri(r as AriOcc);
    } catch (e) {
      setAri({ ok: false, message: e instanceof Error ? e.message : "sync failed" });
    } finally {
      setBusy(false);
    }
  }

  // Probe both MiniHotel APIs and produce a copy-paste report for their support.
  async function genLog() {
    setBusy(true);
    setLog(null);
    try {
      const r = await fetch("/api/integrations/minihotel/diagnostics", { method: "POST" }).then((res) =>
        res.json(),
      );
      setLog(r.ok ? r.log : r.message || "Could not generate log.");
    } catch (e) {
      setLog(e instanceof Error ? e.message : "Could not generate log.");
    } finally {
      setBusy(false);
    }
  }
  function copyLog() {
    if (log) navigator.clipboard?.writeText(log).catch(() => undefined);
  }
  function downloadLog() {
    if (!log) return;
    const blob = new Blob([log], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `minihotel-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const configured = hasPassword && !!username && !!hotelId;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" /> MiniHotel connection
          </CardTitle>
          <Badge variant={configured ? "success" : "muted"}>{configured ? "configured" : "not set"}</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Credentials the Hub uses to read rates &amp; bookings and push prices back to MiniHotel. Auth
          is username + password + hotel id (no tokens) — and your box&apos;s IP must be whitelisted with
          MiniHotel.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
          <label className="flex flex-col gap-1">
            Environment
            <select
              className={`${input} w-36`}
              value={env}
              onChange={(e) => setEnv(e.target.value === "production" ? "production" : "sandbox")}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Username
            <input className={`${input} w-40`} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Test" />
          </label>
          <label className="flex flex-col gap-1">
            Password
            <input
              type="password"
              className={`${input} w-40`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasPassword ? "•••••• (unchanged)" : "password"}
              autoComplete="new-password"
            />
          </label>
          <label className="flex flex-col gap-1">
            Hotel ID
            <input className={`${input} w-40`} value={hotelId} onChange={(e) => setHotelId(e.target.value)} placeholder="sandbox" />
          </label>
          <label className="flex flex-col gap-1">
            Rate code (price list)
            <input className={`${input} w-40`} value={rateCode} onChange={(e) => setRateCode(e.target.value)} placeholder="USD / ILS / Standard" />
          </label>
          <button type="button" disabled={busy} onClick={save} className={btn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saved ? "Saved ✓" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={runTest} className={btnGhost}>
            Test connection
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-dashed border-border bg-muted/10 px-3 py-2.5 text-[11px] text-muted-foreground">
          <div className="w-full text-[10px] font-medium uppercase tracking-wide text-foreground/70">
            Content API login — only if MiniHotel gave you separate booking credentials
          </div>
          <label className="flex flex-col gap-1">
            Content username
            <input
              className={`${input} w-40`}
              value={contentUsername}
              onChange={(e) => setContentUsername(e.target.value)}
              placeholder="(same as above)"
            />
          </label>
          <label className="flex flex-col gap-1">
            Content password
            <input
              type="password"
              className={`${input} w-40`}
              value={contentPassword}
              onChange={(e) => setContentPassword(e.target.value)}
              placeholder={hasContentPassword ? "•••••• (unchanged)" : "(same as above)"}
              autoComplete="new-password"
            />
          </label>
          <p className="w-full text-[10px] text-muted-foreground">
            Reservations come from MiniHotel&apos;s Content &amp; Data API, which some accounts authorize
            with a different login than ARI. Leave blank to reuse the main username/password above.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
          <div className="w-full text-[10px] font-medium uppercase tracking-wide text-foreground/70">
            Revenue actuals — VAT &amp; exclusions
          </div>
          <label className="flex flex-col gap-1">
            VAT % (locals only)
            <input
              className={`${input} w-24`}
              value={vatRate}
              onChange={(e) => setVatRate(e.target.value)}
              placeholder="18"
              inputMode="decimal"
            />
          </label>
          <label className="flex flex-col gap-1">
            VAT-liable countries
            <input
              className={`${input} w-44`}
              value={vatCountries}
              onChange={(e) => setVatCountries(e.target.value)}
              placeholder="IL, ISR, ISRAEL"
            />
          </label>
          <label className="flex flex-col gap-1">
            Test room codes / numbers (excluded)
            <input
              className={`${input} w-56`}
              value={excludedRoomTypes}
              onChange={(e) => setExcludedRoomTypes(e.target.value)}
              placeholder="TEST, DEMO, 999"
            />
          </label>
          <p className="w-full text-[10px] text-muted-foreground">
            Revenue is recorded net of VAT — Israeli guests pay {vatRate || "18"}% (stripped out),
            tourists are zero-rated. Reservations on test room codes/numbers stay out of the P&amp;L.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <button type="button" disabled={busy} onClick={pullReservations} className={btn}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
            Pull reservations → P&amp;L
          </button>
          <button type="button" disabled={busy} onClick={tryAri} className={btnGhost}>
            Sync occupancy (ARI)
          </button>
          {pull ? (
            pull.ok ? (
              <span className="w-full text-[11px] text-foreground">
                ✓ {pull.parsed} pulled ·{" "}
                <span className="font-medium">
                  {pull.month}: ₪{(pull.net ?? 0).toLocaleString()} net
                </span>{" "}
                from {pull.count} bookings · ₪{(pull.vat ?? 0).toLocaleString()} VAT removed
                {pull.test ? ` · ${pull.test} test excluded` : ""}
              </span>
            ) : (
              <span className="w-full text-[11px] text-[hsl(var(--warning))]">Pull failed: {pull.message}</span>
            )
          ) : (
            <span className="w-full text-[10px] text-muted-foreground">
              <b>Pull reservations → P&amp;L</b> uses the Content &amp; Data API (real revenue, VAT-correct).
              <b> Sync occupancy (ARI)</b> stores the real bookings from the server that already works —
              occupancy only, no prices. Run both from the box.
            </span>
          )}
          {ari ? (
            ari.ok ? (
              <span className="w-full text-[11px] text-foreground">
                ✓ {(ari.bookings ?? 0).toLocaleString()} bookings · {ari.rooms} rooms ·{" "}
                <span className="font-medium">
                  {ari.thisMonth} occupancy {Math.round((ari.occupancy ?? 0) * 100)}%
                </span>{" "}
                ({(ari.bookedNights ?? 0).toLocaleString()} booked nights)
              </span>
            ) : (
              <span className="w-full text-[11px] text-[hsl(var(--warning))]">Sync failed: {ari.message}</span>
            )
          ) : null}
        </div>

        {endpoints && (
          <div className="space-y-0.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
            <div>
              Read ARI: <span className="text-foreground">{endpoints.ari}</span>
            </div>
            <div>
              Push ARI: <span className="text-foreground">{endpoints.reverse}</span>
            </div>
          </div>
        )}

        {test && (
          <div className="space-y-1.5">
            {test.ari ? <ProbeLine label="ARI API — rates, availability, price push" row={test.ari} /> : null}
            {test.content ? (
              <ProbeLine label="Content & Data API — bookings, room types, folio" row={test.content} />
            ) : null}
            {!test.ari && !test.content && (
              <div
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
                  test.ok
                    ? "border-success/20 bg-success/10 text-[hsl(var(--success))]"
                    : "border-warning/20 bg-warning/10 text-muted-foreground"
                }`}
              >
                {test.ok ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
                <span>{test.message}</span>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={genLog} className={btnGhost}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Generate MiniHotel support log
            </button>
            {log ? (
              <>
                <button type="button" onClick={copyLog} className={btnGhost}>
                  Copy
                </button>
                <button type="button" onClick={downloadLog} className={btnGhost}>
                  Download .txt
                </button>
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                Probes both MiniHotel APIs and writes a copy-paste report for their support (password
                redacted). Run from the box.
              </span>
            )}
          </div>
          {log ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground">
              {log}
            </pre>
          ) : null}
        </div>

        <p className="text-[10px] text-muted-foreground">
          Stored on this server only. The password is write-only here — it is never shown again after
          saving (leave it blank to keep the current one).
        </p>
      </CardContent>
    </Card>
  );
}

function ProbeLine({ label, row }: { label: string; row: { ok: boolean; detail: string } }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${
        row.ok
          ? "border-success/20 bg-success/10 text-[hsl(var(--success))]"
          : "border-warning/20 bg-warning/10 text-muted-foreground"
      }`}
    >
      {row.ok ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
      <span>
        <span className="font-medium">{label}:</span> {row.ok ? "OK" : "not available"}
        {row.detail ? ` — ${row.detail}` : ""}
      </span>
    </div>
  );
}
