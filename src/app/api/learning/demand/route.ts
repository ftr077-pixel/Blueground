import { NextResponse } from "next/server";
import {
  demandSignal,
  demandSummary,
  parseDemandText,
  recordDemandReadings,
} from "@/lib/learning/demand";

export const dynamic = "force-dynamic";

// GET ?profileId=…&nights=30[&checkIn=YYYY-MM-DD]
//   → one relative demand signal for the date, or the area's upcoming summary.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const profileId = p.get("profileId");
  if (!profileId) return NextResponse.json({ error: "profileId required" }, { status: 400 });
  const nights = Number(p.get("nights") ?? "30");
  const checkIn = p.get("checkIn");
  if (checkIn) return NextResponse.json(demandSignal(profileId, nights, checkIn));
  return NextResponse.json({ signals: demandSummary(profileId, nights) });
}

// POST { area, source?, readings: [{date, value}] } or { area, source?, text }
// where text is pasteable "YYYY-MM-DD value" lines (e.g. a market-occupancy
// export). Values are stored raw; interpretation is always relative.
export async function POST(req: Request) {
  let body: {
    area?: string;
    source?: string;
    readings?: Array<{ date: string; value: number }>;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.area?.trim()) return NextResponse.json({ error: "area required" }, { status: 400 });
  const readings = body.readings?.length
    ? body.readings
    : body.text
      ? parseDemandText(body.text)
      : [];
  if (!readings.length) {
    return NextResponse.json({ error: "no parsable readings" }, { status: 400 });
  }
  const recorded = recordDemandReadings({ area: body.area, source: body.source, readings });
  return NextResponse.json({ ok: true, recorded });
}
