"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  GitBranch,
  Hash,
  Loader2,
  Lock,
  PauseCircle,
  PlayCircle,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Terminal } from "@/components/synthesis/terminal";
import { TurnFeed } from "@/components/synthesis/turn-feed";
import { SpecViewer } from "@/components/synthesis/spec-viewer";
import type { SynthesisTurn, TerminalLine } from "@/lib/synthesis-data";
import type { OrchestratorTickResponse } from "@/app/api/orchestrator/tick/route";
import { cn, formatRelative } from "@/lib/utils";

const POLL_MS = 320;

type Meta = {
  state: OrchestratorTickResponse["state"];
  phase: string;
  turnCount: number;
  done: boolean;
  driver: OrchestratorTickResponse["driver"];
  startedAt: string | null;
  workspace: string;
};

const INITIAL_META: Meta = {
  state: "RUNNING",
  phase: "Init",
  turnCount: 0,
  done: false,
  driver: null,
  startedAt: null,
  workspace: "rental-orchestrator-hub",
};

export function SynthesisLive({
  spec,
  initialRunId,
  liveAvailable,
}: {
  spec: string;
  initialRunId: string | null;
  liveAvailable: boolean;
}) {
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [turns, setTurns] = useState<SynthesisTurn[]>([]);
  const [lineCursor, setLineCursor] = useState(0);
  const [turnCursor, setTurnCursor] = useState(0);
  const [meta, setMeta] = useState<Meta>(INITIAL_META);
  const [bumpKey, setBumpKey] = useState(0);
  const [starting, setStarting] = useState<"scripted" | "live" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Polling effect — runs whenever runId or cursors change, until done.
  useEffect(() => {
    if (!runId) return;
    if (meta.done) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const url = `/api/orchestrator/tick?runId=${encodeURIComponent(runId)}&lineCursor=${lineCursor}&turnCursor=${turnCursor}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const body: OrchestratorTickResponse = await res.json();
        if (cancelled) return;
        if (body.newLines.length) setLines((prev) => [...prev, ...body.newLines]);
        if (body.newTurns.length) setTurns((prev) => [...prev, ...body.newTurns]);
        setLineCursor(body.lineCursor);
        setTurnCursor(body.turnCursor);
        setMeta({
          state: body.state,
          phase: body.phase,
          turnCount: body.turnCount,
          done: body.done,
          driver: body.driver,
          startedAt: body.startedAt,
          workspace: body.workspace,
        });
      } catch {
        // network blip — next tick will retry
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [runId, lineCursor, turnCursor, meta.done, bumpKey]);

  async function startRun(driver: "scripted" | "live") {
    setStarting(driver);
    setError(null);
    try {
      const res = await fetch("/api/orchestrator/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `start failed: ${res.status}`);
      }
      const body = (await res.json()) as { run: { id: string } };
      setLines([]);
      setTurns([]);
      setLineCursor(0);
      setTurnCursor(0);
      setMeta(INITIAL_META);
      setRunId(body.run.id);
      setBumpKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start run");
    } finally {
      setStarting(null);
    }
  }

  const stateBadge =
    meta.state === "COACH_APPROVED"
      ? { variant: "success" as const, label: "Coach approved" }
      : meta.state === "BLOCKED"
        ? { variant: "danger" as const, label: "Blocked" }
        : meta.state === "ERROR"
          ? { variant: "danger" as const, label: "Error" }
          : meta.state === "IDLE"
            ? { variant: "muted" as const, label: "Idle" }
            : { variant: "info" as const, label: "Loop running" };

  const streaming = !meta.done && meta.state === "RUNNING";

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Dialectical orchestrator
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-semibold tracking-tight">
            Synthesis View
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Player generates code + bash; the sandbox executes; the Coach grades the captured logs
            against <code className="text-foreground">spec.md</code>. Loop until approval.
          </p>
        </div>

        <Card className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <Activity
                className={cn(
                  "h-3.5 w-3.5",
                  meta.state === "COACH_APPROVED" ? "text-success" : "text-primary",
                )}
              />
              <span className="text-muted-foreground">Status</span>
              <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Hash className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Turn</span>
              <span className="font-semibold">{meta.turnCount}</span>
            </div>
            <div className="flex items-center gap-2">
              {streaming ? (
                <PlayCircle className="h-3.5 w-3.5 text-primary" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="text-muted-foreground">{meta.phase}</span>
            </div>
            {meta.driver && (
              <Badge variant={meta.driver === "live" ? "info" : "muted"}>
                {meta.driver} driver
              </Badge>
            )}
            {meta.startedAt && (
              <span className="text-[10px] text-muted-foreground">
                started {formatRelative(meta.startedAt)}
              </span>
            )}
          </div>
        </Card>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => startRun("scripted")}
          disabled={starting !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {starting === "scripted" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCw className="h-3 w-3" />
          )}
          New scripted run
        </button>
        <button
          type="button"
          onClick={() => startRun("live")}
          disabled={!liveAvailable || starting !== null}
          title={
            liveAvailable
              ? "Run a real Player↔Coach loop against spec.md"
              : "ANTHROPIC_API_KEY is not set"
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
        >
          {starting === "live" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : liveAvailable ? (
            <Sparkles className="h-3 w-3" />
          ) : (
            <Lock className="h-3 w-3" />
          )}
          New live run {liveAvailable ? "" : "(set ANTHROPIC_API_KEY)"}
        </button>
        {runId && (
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">
            run · {runId}
          </span>
        )}
      </div>
      {error && (
        <Card className="border-danger/40 bg-danger/10 px-4 py-3 text-xs text-[hsl(var(--danger))]">
          {error}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-7 self-start">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Player ↔ Coach feed</CardTitle>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {turns.length} turns logged
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Alternating execution and validation turns for workspace
              <span className="ml-1 font-mono text-foreground">{meta.workspace}</span>.
            </p>
          </CardHeader>
          <CardContent className="max-h-[720px] overflow-y-auto pr-2">
            {turns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-background/30 p-8 text-center text-xs text-muted-foreground">
                Awaiting first turn from the orchestrator…
              </div>
            ) : (
              <TurnFeed turns={turns} />
            )}
          </CardContent>
        </Card>

        <div className="xl:col-span-5 space-y-6">
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground">
              <span>Live terminal · sandbox stdout / stderr</span>
              <span>{lines.length} lines</span>
            </div>
            <Terminal lines={lines} streaming={streaming} />
          </div>
          <div>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Requirements contract
            </div>
            <SpecViewer markdown={spec} />
          </div>
        </div>
      </div>
    </div>
  );
}
