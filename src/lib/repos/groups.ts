// Customization groups (PriceLabs "Manage Multiple Listings with Group
// Customizations"). A group customization is just a NAME: it can be attached to
// a listing as its group or its sub-group, and it owns a scoped rule-override
// blob (see rules-config.ts scopes). Hierarchy when resolving rules:
// listing > sub-group > group > account > code defaults.

import { getDb } from "@/lib/db";
import { listUnits, type Unit } from "@/lib/repos/units";
import { getSetting, setSetting } from "@/lib/repos/visibility";
import { bookedDatesForUnit } from "@/lib/repos/rates";

const GROUPS_KEY = "pricing_groups";

export function listGroupNames(): string[] {
  const raw = getSetting(GROUPS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function createGroup(name: string): string[] {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("group name required");
  const names = listGroupNames();
  if (!names.includes(n)) names.push(n);
  setSetting(GROUPS_KEY, JSON.stringify(names.sort()));
  return names;
}

export function deleteGroup(name: string): string[] {
  const names = listGroupNames().filter((g) => g !== name);
  setSetting(GROUPS_KEY, JSON.stringify(names));
  // Detach from any unit using it as group or sub-group.
  getDb()
    .prepare(
      `UPDATE units SET
         customization_subgroup = CASE WHEN customization_subgroup = @n THEN NULL ELSE customization_subgroup END,
         customization_group   = CASE WHEN customization_group   = @n THEN NULL ELSE customization_group END`,
    )
    .run({ n: name });
  return names;
}

/** Units attached to a group customization — as their group OR sub-group. */
export function groupMembers(name: string, units: Unit[] = listUnits()): Unit[] {
  return units.filter((u) => u.group === name || u.subgroup === name);
}

/** Combined forward occupancy (next `days` nights) across a set of units —
 *  booked member-nights ÷ total member-nights. Powers the Group Calendar
 *  occupancy view and the Portfolio OBA group signal. */
export function combinedOccupancy(units: Unit[], days = 30): number | null {
  if (units.length === 0) return null;
  const from = new Date().toISOString().slice(0, 10);
  let booked = 0;
  for (const u of units) booked += bookedDatesForUnit(u.id, from, days).size;
  return booked / (units.length * days);
}

// ------------------------------------------------------ Group Creation Wizard
export type WizardStrategy = "city" | "bedroom" | "city_bedroom";

export interface WizardSuggestion {
  name: string;
  /** Every listing matching the bucket (the UI greys out already-grouped ones). */
  unitIds: string[];
  /** Subset of unitIds that already belong to a group — a listing can only be
   *  in one group, so these can't be auto-assigned (PriceLabs wizard rule). */
  alreadyGrouped: string[];
}

/** Suggest group structures from listing attributes. "City" maps to our
 *  neighborhoods; the City + Bedroom default is PriceLabs's recommended
 *  granularity. Suggestions only — nothing is applied until the operator
 *  confirms (the wizard never auto-groups). */
export function wizardSuggestions(strategy: WizardStrategy): WizardSuggestion[] {
  const keyOf = (u: Unit) =>
    strategy === "city"
      ? u.neighborhood
      : strategy === "bedroom"
        ? `${u.bedrooms}BR`
        : `${u.neighborhood} · ${u.bedrooms}BR`;
  const buckets = new Map<string, Unit[]>();
  for (const u of listUnits()) {
    const k = keyOf(u);
    const arr = buckets.get(k);
    if (arr) arr.push(u);
    else buckets.set(k, [u]);
  }
  return [...buckets.entries()]
    .filter(([, us]) => us.length >= 2) // a group of one defeats the purpose
    .map(([name, us]) => ({
      name,
      unitIds: us.map((u) => u.id),
      alreadyGrouped: us.filter((u) => u.group || u.subgroup).map((u) => u.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
