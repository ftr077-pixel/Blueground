import { NextResponse } from "next/server";
import { upsertMarketSnapshot } from "@/lib/repos/market";
import { setSetting } from "@/lib/repos/visibility";
import { logActivity } from "@/lib/repos/activity";
import { parsePriceLabsUploads, type UploadFile } from "@/lib/pricing/pricelabs-parse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Browser upload from the Market Analytics dashboard: the operator drops the
// PriceLabs report files here. Behind the dashboard login (NOT in the scraper-key
// bypass), so no API key is exposed to the browser. Parses the CSVs, upserts one
// PriceLabs market snapshot, and makes PriceLabs the active source of truth.
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }

  const files: UploadFile[] = [];
  for (const [, v] of form.entries()) {
    if (v instanceof File) files.push({ name: v.name, text: await v.text() });
  }
  if (!files.length) return NextResponse.json({ error: "no files uploaded" }, { status: 400 });

  const { area, used, skipped, stats } = parsePriceLabsUploads(files);
  if (!area) {
    return NextResponse.json(
      {
        error:
          "No recognizable PriceLabs CSVs found. Include the market_history / occupancy / prices / supply_demand exports.",
        skipped,
      },
      { status: 400 },
    );
  }

  upsertMarketSnapshot(area);
  setSetting("market_source", "pricelabs");
  logActivity({
    department: "revenue",
    worker: "Pricing Specialist",
    message: `PriceLabs upload: ${used.length} report(s) → ${stats.metrics} month(s) history, ${stats.pacing} forward day(s).`,
    level: "info",
  });

  return NextResponse.json({ ok: true, area: area.marketName, used, skipped, stats });
}
