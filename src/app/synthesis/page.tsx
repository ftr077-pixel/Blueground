import { Activity, GitBranch, Hash, PauseCircle, PlayCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TurnFeed } from "@/components/synthesis/turn-feed";
import { Terminal } from "@/components/synthesis/terminal";
import { SpecViewer } from "@/components/synthesis/spec-viewer";
import { loadSpec } from "@/lib/load-spec";
import { formatRelative } from "@/lib/utils";
import {
  SYNTHESIS_TURNS,
  SYNTHESIS_WORKSPACE,
  TERMINAL_LINES,
} from "@/lib/synthesis-data";

export const dynamic = "force-static";

export default async function SynthesisPage() {
  const spec = await loadSpec();

  const stateBadge =
    SYNTHESIS_WORKSPACE.state === "COACH_APPROVED"
      ? { variant: "success" as const, label: "Coach approved" }
      : SYNTHESIS_WORKSPACE.state === "BLOCKED"
        ? { variant: "danger" as const, label: "Blocked" }
        : { variant: "info" as const, label: "Loop running" };

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
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-success" />
              <span className="text-muted-foreground">Status</span>
              <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Hash className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Turn</span>
              <span className="font-semibold">{SYNTHESIS_WORKSPACE.turnCount}</span>
            </div>
            <div className="flex items-center gap-2">
              {SYNTHESIS_WORKSPACE.state === "RUNNING" ? (
                <PlayCircle className="h-3.5 w-3.5 text-primary" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="text-muted-foreground">{SYNTHESIS_WORKSPACE.phase}</span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              started {formatRelative(SYNTHESIS_WORKSPACE.startedAt)}
            </span>
          </div>
        </Card>
      </header>

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-7 self-start">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Player ↔ Coach feed</CardTitle>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {SYNTHESIS_TURNS.length} turns logged
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Alternating execution and validation turns for workspace
              <span className="ml-1 font-mono text-foreground">{SYNTHESIS_WORKSPACE.name}</span>.
            </p>
          </CardHeader>
          <CardContent className="max-h-[720px] overflow-y-auto pr-2">
            <TurnFeed turns={SYNTHESIS_TURNS} />
          </CardContent>
        </Card>

        <div className="xl:col-span-5 space-y-6">
          <div>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              Live terminal · sandbox stdout / stderr
            </div>
            <Terminal lines={TERMINAL_LINES} />
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
