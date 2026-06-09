import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getScanState,
  getSetting,
  markScanFinished,
  markScanStarted,
  setSetting,
} from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

const scraperDir = () => process.env.SCRAPER_DIR || path.join(process.cwd(), "scraper");
const logPath = () => path.join(scraperDir(), "scan.log");

// Status of the current/last scan + a tail of the scraper log (the dashboard polls this).
export async function GET() {
  const state = getScanState();
  let logTail = "";
  try {
    logTail = fs
      .readFileSync(logPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-15)
      .join("\n");
  } catch {
    /* no log yet */
  }
  return NextResponse.json({ ...state, logTail });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { listingIds?: string[]; cancel?: boolean }
    | null;

  // Stop / reset a running (or stuck) scan.
  if (body?.cancel) {
    const pid = Number(getSetting("scan_pid"));
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    markScanFinished("cancelled");
    return NextResponse.json({ cancelled: true });
  }

  if (getScanState().running) {
    return NextResponse.json({ error: "a scan is already running" }, { status: 409 });
  }
  const proxy = getSetting("proxy_url") || process.env.PROXY_URL || "";
  if (!proxy) {
    return NextResponse.json(
      { error: "Set your proxy URL in Manage → Scanner settings first." },
      { status: 400 },
    );
  }

  const listingIds =
    body && Array.isArray(body.listingIds)
      ? body.listingIds.filter((x) => typeof x === "string")
      : [];

  const dir = scraperDir();
  const python = path.join(dir, ".venv", "bin", "python");
  const script = path.join(dir, "run_agent.py");
  const port = process.env.PORT || "3000";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1", // flush scraper output to scan.log live (no block buffering)
    APP_URL: `http://127.0.0.1:${port}`,
    PROXY_URL: proxy,
    SCRAPER_API_KEY: process.env.SCRAPER_API_KEY || "",
  };
  if (listingIds.length) env.SCAN_LISTING_IDS = listingIds.join(",");

  markScanStarted();
  try {
    // Stream the scraper's output to scan.log so a run is observable (and a stuck
    // run shows its last line). stdio was previously discarded.
    const fd = fs.openSync(logPath(), "a");
    fs.writeSync(fd, `\n=== scan ${new Date().toISOString()} (${listingIds.length || "all"}) ===\n`);
    const child = spawn(python, [script], { cwd: dir, env, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    if (child.pid) setSetting("scan_pid", String(child.pid));
    child.on("error", (e) => markScanFinished(`failed to start scanner: ${e.message}`));
    child.on("exit", (code) =>
      markScanFinished(code === 0 ? "scan complete" : `scanner exited with code ${code}`),
    );
  } catch (e) {
    markScanFinished(e instanceof Error ? e.message : "could not start scanner");
    return NextResponse.json({ error: "could not start scanner" }, { status: 500 });
  }
  return NextResponse.json({ started: true, scoped: listingIds.length || "all" });
}
