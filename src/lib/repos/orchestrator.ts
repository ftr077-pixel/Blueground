import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { SynthesisTurn, TerminalLine } from "@/lib/synthesis-data";

export type RunDriver = "scripted" | "live";
export type RunState = "RUNNING" | "BLOCKED" | "COACH_APPROVED" | "ERROR";

export interface Run {
  id: string;
  workspace: string;
  startedAt: string;
  endedAt: string | null;
  state: RunState;
  phase: string;
  turnCount: number;
  driver: RunDriver;
}

interface RunSql {
  id: string;
  workspace: string;
  started_at: string;
  ended_at: string | null;
  state: RunState;
  phase: string;
  turn_count: number;
  driver: RunDriver;
}

function rowToRun(r: RunSql): Run {
  return {
    id: r.id,
    workspace: r.workspace,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    state: r.state,
    phase: r.phase,
    turnCount: r.turn_count,
    driver: r.driver,
  };
}

export function createRun(input: {
  workspace?: string;
  driver: RunDriver;
}): Run {
  const db = getDb();
  const row: Run = {
    id: `run-${randomUUID().slice(0, 8)}`,
    workspace: input.workspace ?? "rental-orchestrator-hub",
    startedAt: new Date().toISOString(),
    endedAt: null,
    state: "RUNNING",
    phase: "Init",
    turnCount: 0,
    driver: input.driver,
  };
  db.prepare(
    `INSERT INTO orchestrator_runs (id, workspace, started_at, ended_at, state, phase, turn_count, driver)
     VALUES (@id, @workspace, @started_at, @ended_at, @state, @phase, @turn_count, @driver)`,
  ).run({
    id: row.id,
    workspace: row.workspace,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    state: row.state,
    phase: row.phase,
    turn_count: row.turnCount,
    driver: row.driver,
  });
  return row;
}

export function updateRun(
  id: string,
  patch: Partial<Pick<Run, "state" | "phase" | "turnCount" | "endedAt">>,
) {
  const db = getDb();
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.state !== undefined) {
    sets.push("state = @state");
    params.state = patch.state;
  }
  if (patch.phase !== undefined) {
    sets.push("phase = @phase");
    params.phase = patch.phase;
  }
  if (patch.turnCount !== undefined) {
    sets.push("turn_count = @turn_count");
    params.turn_count = patch.turnCount;
  }
  if (patch.endedAt !== undefined) {
    sets.push("ended_at = @ended_at");
    params.ended_at = patch.endedAt;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE orchestrator_runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function getRun(id: string): Run | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM orchestrator_runs WHERE id = ?").get(id) as
    | RunSql
    | undefined;
  return row ? rowToRun(row) : null;
}

export function latestRun(): Run | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM orchestrator_runs ORDER BY started_at DESC LIMIT 1")
    .get() as RunSql | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(limit = 20): Run[] {
  const db = getDb();
  return (
    db
      .prepare("SELECT * FROM orchestrator_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as RunSql[]
  ).map(rowToRun);
}

interface TurnSql {
  id: string;
  run_id: string;
  seq: number;
  turn: number;
  role: SynthesisTurn["role"];
  ts: string;
  title: string;
  summary: string;
  artifacts: string;
}

interface LineSql {
  id: string;
  run_id: string;
  seq: number;
  ts: string;
  stream: TerminalLine["stream"];
  text: string;
}

export function appendTurn(runId: string, turn: SynthesisTurn): SynthesisTurn {
  const db = getDb();
  const last = db
    .prepare("SELECT MAX(seq) as max FROM orchestrator_turns WHERE run_id = ?")
    .get(runId) as { max: number | null };
  const seq = (last.max ?? -1) + 1;
  db.prepare(
    `INSERT INTO orchestrator_turns (id, run_id, seq, turn, role, ts, title, summary, artifacts)
     VALUES (@id, @run_id, @seq, @turn, @role, @ts, @title, @summary, @artifacts)`,
  ).run({
    id: turn.id,
    run_id: runId,
    seq,
    turn: turn.turn,
    role: turn.role,
    ts: turn.ts,
    title: turn.title,
    summary: turn.summary,
    artifacts: JSON.stringify(turn.artifacts ?? []),
  });
  return turn;
}

export function appendLine(runId: string, line: TerminalLine): TerminalLine {
  const db = getDb();
  const last = db
    .prepare("SELECT MAX(seq) as max FROM orchestrator_lines WHERE run_id = ?")
    .get(runId) as { max: number | null };
  const seq = (last.max ?? -1) + 1;
  db.prepare(
    `INSERT INTO orchestrator_lines (id, run_id, seq, ts, stream, text)
     VALUES (@id, @run_id, @seq, @ts, @stream, @text)`,
  ).run({
    id: line.id,
    run_id: runId,
    seq,
    ts: line.ts,
    stream: line.stream,
    text: line.text,
  });
  return line;
}

export function turnsSince(runId: string, cursor: number): SynthesisTurn[] {
  const db = getDb();
  return (
    db
      .prepare(
        "SELECT * FROM orchestrator_turns WHERE run_id = ? AND seq >= ? ORDER BY seq ASC",
      )
      .all(runId, cursor) as TurnSql[]
  ).map((t) => ({
    id: t.id,
    turn: t.turn,
    role: t.role,
    ts: t.ts,
    title: t.title,
    summary: t.summary,
    artifacts: JSON.parse(t.artifacts) as SynthesisTurn["artifacts"],
  }));
}

export function linesSince(runId: string, cursor: number): TerminalLine[] {
  const db = getDb();
  return (
    db
      .prepare(
        "SELECT * FROM orchestrator_lines WHERE run_id = ? AND seq >= ? ORDER BY seq ASC",
      )
      .all(runId, cursor) as LineSql[]
  ).map((l) => ({
    id: l.id,
    ts: l.ts,
    stream: l.stream,
    text: l.text,
  }));
}

export function countTurns(runId: string): number {
  const db = getDb();
  const r = db
    .prepare("SELECT COUNT(*) as c FROM orchestrator_turns WHERE run_id = ?")
    .get(runId) as { c: number };
  return r.c;
}

export function countLines(runId: string): number {
  const db = getDb();
  const r = db
    .prepare("SELECT COUNT(*) as c FROM orchestrator_lines WHERE run_id = ?")
    .get(runId) as { c: number };
  return r.c;
}
