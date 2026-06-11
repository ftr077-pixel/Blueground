import { NextResponse } from "next/server";
import { listUnits, setUnitGroup } from "@/lib/repos/units";
import {
  listGroupNames,
  createGroup,
  deleteGroup,
  groupMembers,
  combinedOccupancy,
  wizardSuggestions,
  type WizardStrategy,
} from "@/lib/repos/groups";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

// Customization groups (PriceLabs account → group → sub-group → listing).
// GET lists groups with member counts + combined forward occupancy (the Group
// Calendar signal that also feeds Portfolio OBA); ?wizard=city|bedroom|
// city_bedroom returns Group Creation Wizard suggestions instead. POST
// creates/deletes groups, bulk-assigns listings, and applies wizard picks.

export async function GET(req: Request) {
  const wizard = new URL(req.url).searchParams.get("wizard");
  if (wizard) {
    const strategy: WizardStrategy = (["city", "bedroom", "city_bedroom"] as const).includes(
      wizard as WizardStrategy,
    )
      ? (wizard as WizardStrategy)
      : "city_bedroom";
    return NextResponse.json({ strategy, suggestions: wizardSuggestions(strategy) });
  }
  const units = listUnits();
  const groups = listGroupNames().map((name) => {
    const members = groupMembers(name, units);
    return {
      name,
      members: members.length,
      asGroup: units.filter((u) => u.group === name).length,
      asSubgroup: units.filter((u) => u.subgroup === name).length,
      occ30: combinedOccupancy(members, 30),
    };
  });
  return NextResponse.json({
    groups,
    units: units.map((u) => ({
      id: u.id,
      name: u.name,
      neighborhood: u.neighborhood,
      group: u.group,
      subgroup: u.subgroup,
    })),
  });
}

export async function POST(req: Request) {
  let body: {
    create?: string;
    delete?: string;
    assign?: { unitIds: string[]; group: string | null; subgroup?: string | null };
    /** Group Creation Wizard "Create and Assign": create each group and attach
     *  its (un-grouped) listings — a listing can only belong to one group. */
    wizard?: Array<{ name: string; unitIds: string[] }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (Array.isArray(body.wizard)) {
    const units = new Map(listUnits().map((u) => [u.id, u]));
    let created = 0;
    let assigned = 0;
    let skipped = 0;
    for (const pick of body.wizard) {
      const name = String(pick.name || "").trim().slice(0, 60);
      if (!name || !Array.isArray(pick.unitIds) || pick.unitIds.length === 0) continue;
      createGroup(name);
      created++;
      for (const id of pick.unitIds) {
        const u = units.get(String(id));
        if (!u) continue;
        if (u.group || u.subgroup) {
          skipped++; // already grouped — the wizard never moves a listing
          continue;
        }
        setUnitGroup(u.id, name, null);
        assigned++;
      }
    }
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Group Creation Wizard: ${created} group(s) created, ${assigned} listing(s) assigned${skipped ? `, ${skipped} already-grouped listing(s) left untouched` : ""}.`,
      level: "success",
    });
    return NextResponse.json({ ok: true, created, assigned, skipped });
  }

  if (body.create !== undefined) {
    try {
      const groups = createGroup(String(body.create));
      return NextResponse.json({ ok: true, groups });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "create failed" },
        { status: 400 },
      );
    }
  }

  if (body.delete !== undefined) {
    const name = String(body.delete);
    if (!listGroupNames().includes(name)) {
      return NextResponse.json({ error: `unknown group "${name}"` }, { status: 404 });
    }
    const groups = deleteGroup(name);
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Customization group "${name}" deleted — member listings detached.`,
      level: "info",
    });
    return NextResponse.json({ ok: true, groups });
  }

  if (body.assign) {
    const { unitIds, group, subgroup } = body.assign;
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      return NextResponse.json({ error: "assign.unitIds required" }, { status: 400 });
    }
    const known = listGroupNames();
    if (group && !known.includes(group)) {
      return NextResponse.json({ error: `unknown group "${group}"` }, { status: 400 });
    }
    if (subgroup && !known.includes(subgroup)) {
      return NextResponse.json({ error: `unknown group "${subgroup}"` }, { status: 400 });
    }
    const ids = new Set(listUnits().map((u) => u.id));
    let updated = 0;
    for (const id of unitIds) {
      if (!ids.has(String(id))) continue;
      setUnitGroup(String(id), group ?? null, subgroup ?? null);
      updated++;
    }
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Customization groups: ${updated} listing(s) assigned to ${group ? `"${group}"` : "no group"}${subgroup ? ` / sub-group "${subgroup}"` : ""}.`,
      level: "success",
    });
    return NextResponse.json({ ok: true, updated });
  }

  return NextResponse.json({ error: "nothing to do" }, { status: 400 });
}
