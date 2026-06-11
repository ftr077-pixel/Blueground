import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { RULE_SECTIONS, sectionSourcesForUnit } from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

// Table View for Customizations: one matrix of listing × customization section,
// each cell naming the level that supplies it ("listing" | "subgroup:X" |
// "group:X" | "account" | null = code default). Mirrors the resolution
// hierarchy exactly — a more specific level greys out the broader one.
export async function GET() {
  const rows = listUnits().map((u) => ({
    unitId: u.id,
    name: u.name,
    neighborhood: u.neighborhood,
    group: u.group,
    subgroup: u.subgroup,
    sources: sectionSourcesForUnit(u),
  }));
  return NextResponse.json({ sections: RULE_SECTIONS, rows });
}
