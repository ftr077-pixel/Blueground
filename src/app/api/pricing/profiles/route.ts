import { NextResponse } from "next/server";
import {
  listCicoProfiles,
  upsertCicoProfile,
  setCicoArchived,
} from "@/lib/repos/profiles";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

// Check-in/Check-out Profiles (PriceLabs "Profiles" tab). Profiles are named
// weekday allow-lists for check-in/check-out, attachable to any rules scope.
// No delete — archive only (an attached archived profile keeps applying).

export async function GET(req: Request) {
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return NextResponse.json({ cico: listCicoProfiles(includeArchived) });
}

export async function POST(req: Request) {
  let body: {
    save?: { name: string; allowedCheckin: number[]; allowedCheckout: number[] };
    archive?: string;
    unarchive?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    if (body.save) {
      const all = upsertCicoProfile(body.save);
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `Check-in/Check-out profile "${body.save.name}" saved.`,
        level: "success",
      });
      return NextResponse.json({ ok: true, cico: all.filter((p) => !p.archived) });
    }
    if (body.archive !== undefined || body.unarchive !== undefined) {
      const name = String(body.archive ?? body.unarchive);
      const all = setCicoArchived(name, body.archive !== undefined);
      return NextResponse.json({ ok: true, cico: all.filter((p) => !p.archived) });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "profile update failed" },
      { status: 400 },
    );
  }
  return NextResponse.json({ error: "nothing to do" }, { status: 400 });
}
