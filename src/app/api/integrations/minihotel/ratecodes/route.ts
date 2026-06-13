import { NextResponse } from "next/server";
import { discoverRateCodes, testWriteCodes } from "@/lib/integrations/ratecodes";

export const dynamic = "force-dynamic";

// Probe candidate rate codes against MiniHotel. mode "read" (default) checks the
// ARI read feed; mode "write" does a real Reverse-ARI no-op write to test which
// price list actually ACCEPTS writes (reads and writes use different code spaces).
export async function POST(req: Request) {
  let body: { candidates?: string[] | string; mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — uses the saved code + common defaults
  }
  const extra = Array.isArray(body.candidates)
    ? body.candidates
    : typeof body.candidates === "string"
      ? body.candidates.split(/[,;\n]+/)
      : [];
  const codes = extra.map((s) => s.trim()).filter(Boolean);

  if (body.mode === "write") {
    return NextResponse.json(await testWriteCodes(codes));
  }
  return NextResponse.json(await discoverRateCodes(codes));
}
