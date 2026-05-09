import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const ALLOWLIST = new Set([
  "ls", "cat", "echo", "pwd", "true", "false",
  "node", "npm", "npx", "pytest", "python", "python3",
  "test",
]);

const HARD_TIMEOUT_MS = 30_000;

export interface ExecLine {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface ExecResult {
  command: string;
  exitCode: number;
  durationMs: number;
  lines: ExecLine[];
  rejected?: string;
}

function approxTokenize(cmd: string): string[] {
  // Very loose tokenizer — splits on whitespace, ignores quotes. Adequate for
  // checking the leading binary against the allowlist.
  return cmd.trim().split(/\s+/);
}

export function isAllowed(cmd: string): { ok: true } | { ok: false; reason: string } {
  const tokens = approxTokenize(cmd);
  if (tokens.length === 0) return { ok: false, reason: "empty command" };
  const head = tokens[0];
  if (!ALLOWLIST.has(head)) {
    return { ok: false, reason: `binary "${head}" is not on the orchestrator allowlist` };
  }
  if (cmd.includes("&&") || cmd.includes("||") || cmd.includes(";") || cmd.includes("`")) {
    return { ok: false, reason: "compound shell operators are not allowed" };
  }
  if (cmd.includes("$(") || cmd.includes("..")) {
    return { ok: false, reason: "subshell or parent-dir traversal is not allowed" };
  }
  if (cmd.includes(">/") || cmd.includes(">> /") || cmd.includes(" /")) {
    // Reject obvious absolute-path writes / deletes. Sandbox cwd is enough
    // for what the Player needs to demonstrate against spec.md.
    if (/(^|\s)\/(?!tmp\/sandbox)/.test(cmd)) {
      return { ok: false, reason: "absolute path arguments are not allowed" };
    }
  }
  return { ok: true };
}

export async function ensureSandbox(runId: string): Promise<string> {
  const dir = path.join(process.cwd(), "data", "sandboxes", runId);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "README.md"),
      `# Sandbox for run ${runId}\n\nWritten by the dialectical orchestrator.\n`,
      "utf8",
    );
  }
  return dir;
}

export async function exec(runId: string, command: string): Promise<ExecResult> {
  const start = Date.now();
  const lines: ExecLine[] = [];
  const guard = isAllowed(command);
  if (!guard.ok) {
    lines.push({
      ts: new Date().toISOString(),
      stream: "system",
      text: `[orchestrator] command rejected: ${guard.reason}`,
    });
    return {
      command,
      exitCode: 126,
      durationMs: Date.now() - start,
      lines,
      rejected: guard.reason,
    };
  }

  const cwd = await ensureSandbox(runId);
  lines.push({
    ts: new Date().toISOString(),
    stream: "system",
    text: `[sandbox] $ ${command}`,
  });

  return new Promise<ExecResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      lines.push({
        ts: new Date().toISOString(),
        stream: "system",
        text: `[sandbox] killed after ${HARD_TIMEOUT_MS}ms timeout`,
      });
    }, HARD_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      for (const ln of chunk.toString("utf8").split("\n")) {
        if (ln.length === 0) continue;
        lines.push({ ts: new Date().toISOString(), stream: "stdout", text: ln });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const ln of chunk.toString("utf8").split("\n")) {
        if (ln.length === 0) continue;
        lines.push({ ts: new Date().toISOString(), stream: "stderr", text: ln });
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      lines.push({
        ts: new Date().toISOString(),
        stream: "system",
        text: `[sandbox] exit ${exitCode}`,
      });
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - start,
        lines,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      lines.push({
        ts: new Date().toISOString(),
        stream: "stderr",
        text: `[sandbox] spawn error: ${err.message}`,
      });
      resolve({
        command,
        exitCode: 127,
        durationMs: Date.now() - start,
        lines,
      });
    });
  });
}
