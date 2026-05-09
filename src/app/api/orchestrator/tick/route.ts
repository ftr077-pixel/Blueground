import { NextResponse } from "next/server";
import {
  FINAL_APPROVAL_TURN,
  SYNTHESIS_TURNS,
  TERMINAL_LINES,
  type SynthesisTurn,
  type TerminalLine,
} from "@/lib/synthesis-data";

export const dynamic = "force-dynamic";

export interface OrchestratorState {
  state: "RUNNING" | "BLOCKED" | "COACH_APPROVED";
  phase: "Init" | "Execution Turn" | "Validation Turn" | "Idle";
  turnCount: number;
  done: boolean;
}

export interface OrchestratorTickResponse extends OrchestratorState {
  newLines: TerminalLine[];
  newTurns: SynthesisTurn[];
  lineCursor: number;
  turnCursor: number;
  totalLines: number;
  totalTurns: number;
}

const TERMINAL_BATCH = 1;
const TURN_GATES = [4, 9, 16, 22];

function phaseFor(turnCursor: number, lineCursor: number): OrchestratorState["phase"] {
  if (lineCursor === 0 && turnCursor === 0) return "Init";
  if (turnCursor >= SYNTHESIS_TURNS.length + 1) return "Idle";
  const next = SYNTHESIS_TURNS[turnCursor];
  if (!next) return "Validation Turn";
  return next.role === "player" ? "Execution Turn" : "Validation Turn";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lineCursor = Math.max(0, Number(url.searchParams.get("lineCursor") ?? 0));
  const turnCursor = Math.max(0, Number(url.searchParams.get("turnCursor") ?? 0));

  const newLines: TerminalLine[] = [];
  const newTurns: SynthesisTurn[] = [];

  const allTurns = [...SYNTHESIS_TURNS, FINAL_APPROVAL_TURN];

  let nextLineCursor = lineCursor;
  let nextTurnCursor = turnCursor;

  const gate = TURN_GATES[turnCursor];
  if (typeof gate === "number" && lineCursor < gate) {
    const end = Math.min(gate, lineCursor + TERMINAL_BATCH);
    newLines.push(...TERMINAL_LINES.slice(lineCursor, end));
    nextLineCursor = end;
  } else if (turnCursor < allTurns.length) {
    newTurns.push(allTurns[turnCursor]);
    nextTurnCursor = turnCursor + 1;
  } else if (lineCursor < TERMINAL_LINES.length) {
    const end = Math.min(TERMINAL_LINES.length, lineCursor + TERMINAL_BATCH);
    newLines.push(...TERMINAL_LINES.slice(lineCursor, end));
    nextLineCursor = end;
  }

  const done =
    nextTurnCursor >= allTurns.length && nextLineCursor >= TERMINAL_LINES.length;
  const state: OrchestratorState["state"] = done ? "COACH_APPROVED" : "RUNNING";
  const phase: OrchestratorState["phase"] = done ? "Idle" : phaseFor(nextTurnCursor, nextLineCursor);

  const turnCount = Math.min(
    allTurns.length / 2,
    Math.ceil(nextTurnCursor / 2),
  );

  const body: OrchestratorTickResponse = {
    newLines,
    newTurns,
    lineCursor: nextLineCursor,
    turnCursor: nextTurnCursor,
    totalLines: TERMINAL_LINES.length,
    totalTurns: allTurns.length,
    state,
    phase,
    turnCount,
    done,
  };

  return NextResponse.json(body);
}
