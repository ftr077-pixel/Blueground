import { NextResponse } from "next/server";
import { deleteProfile, updateProfile, type ProfileInput } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const patch = (await req.json().catch(() => null)) as Partial<ProfileInput> | null;
  if (!patch) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  updateProfile(params.id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  deleteProfile(params.id);
  return NextResponse.json({ ok: true });
}
