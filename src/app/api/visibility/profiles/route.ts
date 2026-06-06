import { NextResponse } from "next/server";
import { createProfile, listProfiles, type ProfileInput } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ profiles: listProfiles() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ProfileInput | null;
  if (!body || !body.label || !body.label.trim()) {
    return NextResponse.json({ error: "label required" }, { status: 400 });
  }
  return NextResponse.json(createProfile(body), { status: 201 });
}
