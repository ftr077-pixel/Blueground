import { NextResponse } from "next/server";
import { listActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  return NextResponse.json({ events: listActivity(limit) });
}
