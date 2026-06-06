import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  getScanState,
  getSetting,
  markScanFinished,
  markScanStarted,
} from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Status of the current/last scan (the dashboard polls this).
export async function GET() {
  return NextResponse.json(getScanState());
}

// Kick off a scan on the box by spawning the Python scraper.
export async function POST(req: Request) {
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

  const body = (await req.json().catch(() => null)) as { listingIds?: string[] } | null;
  const listingIds =
    body && Array.isArray(body.listingIds)
      ? body.listingIds.filter((x) => typeof x === "string")
      : [];

  const scraperDir = process.env.SCRAPER_DIR || path.join(process.cwd(), "scraper");
  const python = path.join(scraperDir, ".venv", "bin", "python");
  const script = path.join(scraperDir, "run_agent.py");
  const port = process.env.PORT || "3000";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_URL: `http://127.0.0.1:${port}`,
    PROXY_URL: proxy,
    SCRAPER_API_KEY: process.env.SCRAPER_API_KEY || "",
  };
  if (listingIds.length) env.SCAN_LISTING_IDS = listingIds.join(",");

  markScanStarted();
  try {
    const child = spawn(python, [script], { cwd: scraperDir, env, stdio: "ignore" });
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
