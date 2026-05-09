"use client";

import { useEffect, useState } from "react";
import { Activity, GitBranch, Hash, PauseCircle, PlayCircle, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Terminal } from "@/components/synthesis/terminal";
import { TurnFeed } from "@/components/synthesis/turn-feed";
import { SpecViewer } from "@/components/synthesis/spec-viewer";
import { SYNTHESIS_WORKSPACE, type SynthesisTurn, type TerminalLine } from "@/lib/synthesis-data";
import type { OrchestratorTickResponse } from "@/app/api/orchestrator/tick/route";
import { cn, formatRelative } from "@/lib/utils";

const POLL_MS = 320;

export function SynthesisLive({ spec }: { spec: string }) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [turns, setTurns] = useState<SynthesisTurn[]>([]);
  const [lineCursor, setLineCursor] = useState(0);
  const [turnCursor, setTurnCursor] = useState(0);
  const [meta, setMeta] = useState<{
    state: OrchestratorTickResponse["state"];
    phase: OrchestratorTickResponse["phase"];
    turnCount: number;
    done: boolean;
  }>({ state: "RUNNING", phase: "Init", turnCount: 0, done: false });
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    if (meta.done) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/orchestrator/tick?lineCursor=${lineCursor}&turnCursor=${turnCursor}`,
          { cache: "no-store" },
        );
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
        });
      } catch {
        // network blip — next tick will retry
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [lineCursor, turnCursor, meta.done, bumpKey]);

  const replay = () => {
    setLines([]);
    setTurns([]);
    setLineCursor(0);
    setTurnCursor(0);
    setMeta({ state: "RUNNING", phase: "Init", turnCount: 0, done: false });
    setBumpKey((k) => k + 1);
  };

  const stateBadge =
    meta.state === "COACH_APPROVED"
      ? { variant: "success" as const, label: "Coach approved" }
      : meta.state === "BLOCKED"
        ? { variant: "danger" as const, label: "Blocked" }
        : { variant: "info" as const, label: "Loop running" };

  const streaming = !meta.done;

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
            <span className="text-[10px] text-muted-foreground">
              started {formatRelative(SYNTHESIS_WORKSPACE.startedAt)}
            </span>
            <button
              type="button"
              onClick={replay}
              className="ml-2 inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground hover:bg-muted/60"
            >
              <RotateCw className="h-3 w-3" /> Replay
            </button>
          </div>
        </Card>
      </header>

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
              <span className="ml-1 font-mono text-foreground">{SYNTHESIS_WORKSPACE.name}</span>.
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
