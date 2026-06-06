import { NextResponse } from "next/server";
import { deleteListing, updateListing } from "@/lib/repos/visibility";

export const dynamic = "force-dynamic";

interface ListingPatch {
  label?: string;
  active?: boolean;
  profileId?: string;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const patch = (await req.json().catch(() => null)) as ListingPatch | null;
  if (!patch) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  updateListing(params.id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  deleteListing(params.id);
  return NextResponse.json({ ok: true });
}
