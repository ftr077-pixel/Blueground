import { randomUUID } from "node:crypto";
import {
  appendLine,
  appendTurn,
  countTurns,
  createRun,
  updateRun,
  type Run,
} from "@/lib/repos/orchestrator";
import { callCoach, callPlayer, llmConfigured, type PriorTurn } from "@/lib/orchestrator/llm";
import { exec } from "@/lib/orchestrator/sandbox";
import type { SynthesisTurn, TerminalLine } from "@/lib/synthesis-data";

const MAX_TURNS = 12; // matches spec.md §4.2

function turnId(): string {
  return `t-${randomUUID().slice(0, 8)}`;
}

function lineId(): string {
  return `l-${randomUUID().slice(0, 8)}`;
}

function snippet(s: string, n = 1500): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

async function runLoop(run: Run) {
  const prior: PriorTurn[] = [];
  let lastExec: { command: string; exitCode: number; stdout: string; stderr: string } | null =
    null;
  let turnNumber = 0;

  appendLine(run.id, {
    id: lineId(),
    ts: new Date().toISOString(),
    stream: "system",
    text: `[orchestrator] live driver started · run ${run.id} · MAX_TURNS=${MAX_TURNS}`,
  });

  for (let i = 0; i < MAX_TURNS; i++) {
    turnNumber = i + 1;
    updateRun(run.id, { phase: "Execution Turn", turnCount: turnNumber });

    // Player
    let playerOut: { title: string; summary: string; command: string };
    try {
      playerOut = await callPlayer({ prior, lastExec });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLine(run.id, {
        id: lineId(),
        ts: new Date().toISOString(),
        stream: "stderr",
        text: `[orchestrator] Player call failed: ${msg}`,
      });
      updateRun(run.id, { state: "ERROR", phase: "Idle", endedAt: new Date().toISOString() });
      return;
    }

    const playerTurn: SynthesisTurn = {
      id: turnId(),
      turn: turnNumber,
      role: "player",
      ts: new Date().toISOString(),
      title: playerOut.title,
      summary: playerOut.summary,
      artifacts: [{ kind: "bash", body: `$ ${playerOut.command}` }],
    };
    appendTurn(run.id, playerTurn);
    prior.push({
      role: "player",
      turn: turnNumber,
      title: playerOut.title,
      summary: playerOut.summary,
      artifacts: `$ ${playerOut.command}`,
    });

    // Sandbox
    const exec_ = await exec(run.id, playerOut.command);
    for (const ln of exec_.lines) {
      appendLine(run.id, {
        id: lineId(),
        ts: ln.ts,
        stream: ln.stream,
        text: ln.text,
      } as TerminalLine);
    }
    const stdout = exec_.lines.filter((l) => l.stream === "stdout").map((l) => l.text).join("\n");
    const stderr = exec_.lines.filter((l) => l.stream === "stderr").map((l) => l.text).join("\n");
    lastExec = {
      command: exec_.command,
      exitCode: exec_.exitCode,
      stdout: snippet(stdout),
      stderr: snippet(stderr),
    };

    // Coach
    updateRun(run.id, { phase: "Validation Turn" });
    let coachOut: { title: string; summary: string; checklist: string; verdict: string };
    try {
      coachOut = await callCoach({ prior, lastExec });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLine(run.id, {
        id: lineId(),
        ts: new Date().toISOString(),
        stream: "stderr",
        text: `[orchestrator] Coach call failed: ${msg}`,
      });
      updateRun(run.id, { state: "ERROR", phase: "Idle", endedAt: new Date().toISOString() });
      return;
    }

    const coachTurn: SynthesisTurn = {
      id: turnId(),
      turn: turnNumber,
      role: "coach",
      ts: new Date().toISOString(),
      title: coachOut.title,
      summary: coachOut.summary,
      artifacts: [
        { kind: "checklist", body: coachOut.checklist },
        { kind: "verdict", body: coachOut.verdict },
      ],
    };
    appendTurn(run.id, coachTurn);
    prior.push({
      role: "coach",
      turn: turnNumber,
      title: coachOut.title,
      summary: coachOut.summary,
      artifacts: `${coachOut.checklist}\n${coachOut.verdict}`,
    });

    if (coachOut.verdict.startsWith("FINAL STATUS: COACH APPROVED")) {
      updateRun(run.id, {
        state: "COACH_APPROVED",
        phase: "Idle",
        endedAt: new Date().toISOString(),
      });
      return;
    }
  }

  // Max turns reached without approval — spec.md §4.2 says BLOCK.
  appendLine(run.id, {
    id: lineId(),
    ts: new Date().toISOString(),
    stream: "system",
    text: `[orchestrator] turn_count >= ${MAX_TURNS} without approval — transitioning to BLOCKED`,
  });
  updateRun(run.id, { state: "BLOCKED", phase: "Idle", endedAt: new Date().toISOString() });
}

/**
 * Kicks off a real Player↔Coach loop. Returns immediately with the new run;
 * the loop runs in the background and writes turns + lines to the DB as they
 * happen. The polling client picks up updates via /api/orchestrator/tick.
 *
 * Note: fire-and-forget works under `next start` (long-lived process). On a
 * serverless host, this would need a real queue (BullMQ, Cloud Tasks, etc.).
 */
export function startLiveRun(): { run: Run } {
  if (!llmConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot start a live run");
  }
  const totalTurns = countTurns; // referenced to silence unused import warnings if any
  void totalTurns;
  const run = createRun({ driver: "live" });
  appendLine(run.id, {
    id: lineId(),
    ts: new Date().toISOString(),
    stream: "system",
    text: `[orchestrator] booting sandbox for ${run.id}`,
  });
  // Fire-and-forget. Errors are persisted via updateRun(state: 'ERROR').
  void runLoop(run).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    appendLine(run.id, {
      id: lineId(),
      ts: new Date().toISOString(),
      stream: "stderr",
      text: `[orchestrator] uncaught: ${msg}`,
    });
    updateRun(run.id, { state: "ERROR", phase: "Idle", endedAt: new Date().toISOString() });
  });
  return { run };
}
