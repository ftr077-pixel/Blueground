"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

// One-click deploy: pull from GitHub, reinstall, rebuild, restart — no SSH.
export function UpdateCard() {
  const [updating, setUpdating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadUpdate(): Promise<boolean> {
    try {
      const r = await fetch("/api/admin/update", { cache: "no-store" });
      const s = (await r.json()) as { state: string; message?: string };
      const isUpdating = s.state === "updating";
      setUpdating(isUpdating);
      if (s.state === "done") setMsg("updated ✓ — reload the page to see changes");
      else if (s.state === "error") setMsg(`update failed: ${s.message ?? ""}`);
      else if (s.state === "updating") setMsg(s.message ?? "updating…");
      else setMsg(null);
      return isUpdating;
    } catch {
      return true; // app is probably restarting — keep polling
    }
  }

  useEffect(() => {
    loadUpdate();
  }, []);

  useEffect(() => {
    if (!updating) return;
    const t = setInterval(async () => {
      const u = await loadUpdate();
      if (!u) clearInterval(t);
    }, 4000);
    return () => clearInterval(t);
  }, [updating]);

  async function runUpdate() {
    if (
      !confirm(
        "Pull the latest version from GitHub, rebuild, and restart the app? The dashboard will blink for a minute.",
      )
    )
      return;
    setMsg("starting…");
    try {
      const r = await fetch("/api/admin/update", { method: "POST" });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setMsg(e.error || "could not start update");
        return;
      }
      setUpdating(true);
    } catch {
      setMsg("could not start update");
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>App updates</CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Pull the newest version from GitHub, rebuild, and restart — no SSH needed.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={updating} onClick={runUpdate} className={btn}>
            {updating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {updating ? "Updating…" : "Update from GitHub"}
          </button>
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
        </div>
        {updating && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Takes ~1–3 min; the app restarts, so the page may briefly disconnect — it&apos;ll come
            back on the new version (reload it).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
