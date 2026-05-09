import {
  FINAL_APPROVAL_TURN,
  SYNTHESIS_TURNS,
  TERMINAL_LINES,
} from "@/lib/synthesis-data";
import {
  appendLine,
  appendTurn,
  createRun,
  updateRun,
  type Run,
} from "@/lib/repos/orchestrator";

/**
 * Pre-populates a fresh run from the canonical scripted timeline.
 * The polling client paces playback via cursor pagination; rows are
 * persisted in interleaved order to match the original demo cadence.
 */
export function startScriptedRun(): Run {
  const run = createRun({ driver: "scripted" });
  const turns = [...SYNTHESIS_TURNS, FINAL_APPROVAL_TURN];

  // Lines flushed in chunks between Player/Coach turns (mirrors prior TURN_GATES).
  const GATES = [4, 9, 16, 22];
  let lineIdx = 0;

  for (let t = 0; t < turns.length; t++) {
    const gate = GATES[t];
    if (typeof gate === "number") {
      while (lineIdx < gate && lineIdx < TERMINAL_LINES.length) {
        appendLine(run.id, TERMINAL_LINES[lineIdx]);
        lineIdx++;
      }
    }
    appendTurn(run.id, turns[t]);
  }
  while (lineIdx < TERMINAL_LINES.length) {
    appendLine(run.id, TERMINAL_LINES[lineIdx]);
    lineIdx++;
  }

  updateRun(run.id, {
    state: "COACH_APPROVED",
    phase: "Idle",
    turnCount: Math.ceil(turns.length / 2),
    endedAt: new Date().toISOString(),
  });

  return run;
}
