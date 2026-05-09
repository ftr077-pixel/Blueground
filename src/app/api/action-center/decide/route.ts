import { NextResponse } from "next/server";
import { decide } from "@/lib/repos/action-center";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { itemId?: string; outcome?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.itemId || (body.outcome !== "approved" && body.outcome !== "rejected")) {
    return NextResponse.json(
      { error: "itemId and outcome (approved|rejected) are required" },
      { status: 400 },
    );
  }
  try {
    const decision = decide(body.itemId, body.outcome);
    return NextResponse.json({ decision });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
