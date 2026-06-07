import { NextResponse } from "next/server";
import { bulkSetRentAddress } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

// Bulk-set rent + address from pasted rows. Returns { updated, unmatched }.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  return NextResponse.json(bulkSetRentAddress(body.text));
}
