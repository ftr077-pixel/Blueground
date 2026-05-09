import { NextResponse } from "next/server";
import { listRuns, latestRun } from "@/lib/repos/orchestrator";
import { startScriptedRun } from "@/lib/orchestrator/scripted-driver";
import { startLiveRun } from "@/lib/orchestrator/live-driver";
import { llmConfigured } from "@/lib/orchestrator/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    runs: listRuns(20),
    latest: latestRun(),
    liveAvailable: llmConfigured(),
  });
}

export async function POST(req: Request) {
  let body: { driver?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const driver = body.driver ?? "scripted";
  if (driver === "scripted") {
    const run = startScriptedRun();
    return NextResponse.json({ run });
  }
  if (driver === "live") {
    if (!llmConfigured()) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not set — cannot start a live run" },
        { status: 412 },
      );
    }
    try {
      const { run } = startLiveRun();
      return NextResponse.json({ run });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }
  return NextResponse.json({ error: `unknown driver "${driver}"` }, { status: 400 });
}
