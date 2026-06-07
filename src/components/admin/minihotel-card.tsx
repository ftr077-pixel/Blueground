"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, ShieldAlert, ShieldCheck } from "lucide-react";
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
  endpoints: { ari: string; reverse: string; content: string };
}

export function MiniHotelCard() {
  const [env, setEnv] = useState<"sandbox" | "production">("sandbox");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hotelId, setHotelId] = useState("");
  const [rateCode, setRateCode] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [endpoints, setEndpoints] = useState<View["endpoints"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const apply = useCallback((v: View) => {
    setEnv(v.env);
    setUsername(v.username);
    setHotelId(v.hotelId);
    setRateCode(v.rateCode);
    setHasPassword(v.hasPassword);
    setEndpoints(v.endpoints);
    setPassword("");
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
      const body: { env: string; username: string; hotelId: string; rateCode: string; password?: string } = {
        env,
        username,
        hotelId,
        rateCode,
      };
      if (password) body.password = password;
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
      setTest((await r.json()) as { ok: boolean; message: string });
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : "test failed" });
    } finally {
      setBusy(false);
    }
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

        <p className="text-[10px] text-muted-foreground">
          Stored on this server only. The password is write-only here — it is never shown again after
          saving (leave it blank to keep the current one).
        </p>
      </CardContent>
    </Card>
  );
}
