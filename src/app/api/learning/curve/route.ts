import { NextResponse } from "next/server";
import { segmentCurve } from "@/lib/learning/elasticity";

export const dynamic = "force-dynamic";

// GET /api/learning/curve?profileId=…&nights=30&leadBucket=15-30
// → the fitted price→position curve for a segment (for charts / inspection).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get("profileId");
  if (!profileId) {
    return NextResponse.json({ error: "profileId required" }, { status: 400 });
  }
  const nights = Number(searchParams.get("nights") ?? "30");
  const leadBucket = searchParams.get("leadBucket") ?? "15-30";
  return NextResponse.json(segmentCurve(profileId, nights, leadBucket));
}
