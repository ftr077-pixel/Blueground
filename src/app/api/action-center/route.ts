import { NextResponse } from "next/server";
import { listDecisionsWithItems, listPending } from "@/lib/repos/action-center";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    pending: listPending(),
    decisions: listDecisionsWithItems(),
  });
}
