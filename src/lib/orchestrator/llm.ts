import Anthropic from "@anthropic-ai/sdk";
import { loadSpec } from "@/lib/load-spec";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 1500;

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface PriorTurn {
  role: "player" | "coach";
  turn: number;
  title: string;
  summary: string;
  artifacts: string;
}

export interface LastExec {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PLAYER_SYSTEM = `You are the **Player** in a Dialectical Orchestrator loop.

Each turn, you propose ONE bash command to run in a sandboxed workspace, plus a one-line title and a short (max 3-sentence) summary of what the command is meant to verify against spec.md.

Format your response as STRICT JSON, no markdown, no prose outside the JSON, with this shape:

{
  "title": "...",
  "summary": "...",
  "command": "..."
}

Rules:
- The command MUST start with one of: ls, cat, echo, pwd, node, npm, npx, pytest, python, python3, test, true, false.
- No && || ; backticks $() — single command only. No absolute paths.
- Prefer commands that produce evidence the Coach can grade (test runs, file listings, echo of derived facts).`;

const COACH_SYSTEM = `You are the **Coach** in a Dialectical Orchestrator loop.

You evaluate the Player's last command + captured stdout/stderr ONLY against the requirements contract (spec.md). Ignore prose claims of success.

Format your response as STRICT JSON, no markdown, no prose outside the JSON, with this shape:

{
  "title": "...",
  "summary": "...",
  "checklist": "[x] item one\\n[ ] item two ...",
  "verdict": "FINAL STATUS: COACH APPROVED" | "IMMEDIATE ACTIONS NEEDED — <what to do next>"
}

Rules:
- Approve only when every spec.md surface and worker contract has terminal evidence.
- Never approve a turn whose terminal output ended in a non-zero exit code.
- Keep the checklist short (max 8 items) but specific.`;

function priorTurnsAsText(prior: PriorTurn[]): string {
  if (prior.length === 0) return "(no prior turns)";
  return prior
    .slice(-6)
    .map((t) => `### Turn ${t.turn} · ${t.role}\n${t.title}\n${t.summary}\n${t.artifacts}`)
    .join("\n\n");
}

export async function callPlayer(input: {
  prior: PriorTurn[];
  lastExec: LastExec | null;
}): Promise<{ title: string; summary: string; command: string }> {
  const spec = await loadSpec();
  const sys = [
    {
      type: "text" as const,
      text: PLAYER_SYSTEM,
    },
    {
      type: "text" as const,
      text: `# spec.md (ground truth)\n\n${spec}`,
      cache_control: { type: "ephemeral" as const },
    },
  ];
  const userText = [
    `# Prior turns\n${priorTurnsAsText(input.prior)}`,
    input.lastExec
      ? `# Last exec\n$ ${input.lastExec.command}\nexit ${input.lastExec.exitCode}\n--- stdout ---\n${input.lastExec.stdout.slice(-2000)}\n--- stderr ---\n${input.lastExec.stderr.slice(-2000)}`
      : "# Last exec\n(none — this is the first turn)",
    "Propose the next command.",
  ].join("\n\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: sys,
    messages: [{ role: "user", content: userText }],
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  const parsed = JSON.parse(extractJson(text));
  if (typeof parsed.command !== "string") throw new Error("player returned no command");
  return parsed;
}

export async function callCoach(input: {
  prior: PriorTurn[];
  lastExec: LastExec;
}): Promise<{ title: string; summary: string; checklist: string; verdict: string }> {
  const spec = await loadSpec();
  const sys = [
    {
      type: "text" as const,
      text: COACH_SYSTEM,
    },
    {
      type: "text" as const,
      text: `# spec.md (ground truth)\n\n${spec}`,
      cache_control: { type: "ephemeral" as const },
    },
  ];
  const userText = [
    `# Prior turns\n${priorTurnsAsText(input.prior)}`,
    `# Player's last exec\n$ ${input.lastExec.command}\nexit ${input.lastExec.exitCode}\n--- stdout ---\n${input.lastExec.stdout.slice(-2500)}\n--- stderr ---\n${input.lastExec.stderr.slice(-2500)}`,
    "Grade this turn against spec.md and emit checklist + verdict.",
  ].join("\n\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: sys,
    messages: [{ role: "user", content: userText }],
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  return JSON.parse(extractJson(text));
}

function extractJson(s: string): string {
  // Tolerant: find first { ... } block.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model did not return JSON");
  }
  return s.slice(start, end + 1);
}
