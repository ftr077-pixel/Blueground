import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const statusFile = () => path.join(process.cwd(), ".update-status.json");

interface Status {
  state: string;
  at?: string;
  message?: string;
}

function readStatus(): Status {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), "utf8")) as Status;
  } catch {
    return { state: "idle" };
  }
}

export async function GET() {
  return NextResponse.json(readStatus());
}

// Kick off git pull + npm install + build + restart, in its own systemd scope so
// it outlives the restart it triggers.
export async function POST() {
  const s = readStatus();
  if (s.state === "updating" && s.at) {
    const age = Date.now() - new Date(s.at).getTime();
    if (!Number.isNaN(age) && age < 10 * 60 * 1000) {
      return NextResponse.json({ error: "an update is already running" }, { status: 409 });
    }
  }

  const script = path.join(process.cwd(), "deploy", "update.sh");
  try {
    fs.writeFileSync(
      statusFile(),
      JSON.stringify({ state: "updating", at: new Date().toISOString(), message: "starting" }),
    );
    const child = spawn("systemd-run", ["--collect", "/bin/bash", script], { stdio: "ignore" });
    child.on("error", () => {
      try {
        fs.writeFileSync(
          statusFile(),
          JSON.stringify({
            state: "error",
            at: new Date().toISOString(),
            message: "could not launch updater (systemd-run unavailable?)",
          }),
        );
      } catch {
        /* ignore */
      }
    });
  } catch {
    return NextResponse.json({ error: "could not start update" }, { status: 500 });
  }
  return NextResponse.json({ started: true });
}
