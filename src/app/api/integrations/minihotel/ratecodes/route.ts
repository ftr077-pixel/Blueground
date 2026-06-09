import { NextResponse } from "next/server";
import { discoverRateCodes } from "@/lib/integrations/ratecodes";

export const dynamic = "force-dynamic";

// Probe candidate rate codes against MiniHotel and report which are defined.
export async function POST(req: Request) {
  let body: { candidates?: string[] | string } = {};
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
  const result = await discoverRateCodes(extra.map((s) => s.trim()).filter(Boolean));
  return NextResponse.json(result);
}
