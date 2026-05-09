import { NextResponse } from "next/server";
import {
  countLines,
  countTurns,
  getRun,
  latestRun,
  linesSince,
  turnsSince,
} from "@/lib/repos/orchestrator";
import type { SynthesisTurn, TerminalLine } from "@/lib/synthesis-data";

export const dynamic = "force-dynamic";

export interface OrchestratorTickResponse {
  runId: string | null;
  driver: "scripted" | "live" | null;
  newLines: TerminalLine[];
  newTurns: SynthesisTurn[];
  lineCursor: number;
  turnCursor: number;
  totalLines: number;
  totalTurns: number;
  state: "RUNNING" | "BLOCKED" | "COACH_APPROVED" | "ERROR" | "IDLE";
  phase: string;
  turnCount: number;
  done: boolean;
  workspace: string;
  startedAt: string | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedRun = url.searchParams.get("runId");
  const lineCursor = Math.max(0, Number(url.searchParams.get("lineCursor") ?? 0));
  const turnCursor = Math.max(0, Number(url.searchParams.get("turnCursor") ?? 0));

  const run = requestedRun ? getRun(requestedRun) : latestRun();
  if (!run) {
    const empty: OrchestratorTickResponse = {
      runId: null,
      driver: null,
      newLines: [],
      newTurns: [],
      lineCursor: 0,
      turnCursor: 0,
      totalLines: 0,
      totalTurns: 0,
      state: "IDLE",
      phase: "Idle",
      turnCount: 0,
      done: true,
      workspace: "rental-orchestrator-hub",
      startedAt: null,
    };
    return NextResponse.json(empty);
  }

  const newLines = linesSince(run.id, lineCursor);
  const newTurns = turnsSince(run.id, turnCursor);
  const totalLines = countLines(run.id);
  const totalTurns = countTurns(run.id);
  const nextLineCursor = lineCursor + newLines.length;
  const nextTurnCursor = turnCursor + newTurns.length;

  const dbDone =
    run.state === "COACH_APPROVED" || run.state === "BLOCKED" || run.state === "ERROR";
  const cursorsCaught = nextLineCursor >= totalLines && nextTurnCursor >= totalTurns;
  const done = dbDone && cursorsCaught;

  const body: OrchestratorTickResponse = {
    runId: run.id,
    driver: run.driver,
    newLines,
    newTurns,
    lineCursor: nextLineCursor,
    turnCursor: nextTurnCursor,
    totalLines,
    totalTurns,
    state: run.state,
    phase: run.phase,
    turnCount: run.turnCount,
    done,
    workspace: run.workspace,
    startedAt: run.startedAt,
  };
  return NextResponse.json(body);
}
