// Named restriction profiles (PriceLabs "Profiles" tab). Check-in/Check-out
// Profiles hold which weekdays guests may check in / check out; they attach to
// any scope (account / group / listing) through the rules config and, like all
// PriceLabs restriction customizations, apply all-or-nothing per level.
// Profiles can't be deleted — only archived (PriceLabs semantics); an archived
// profile that's still attached somewhere keeps applying.

import { getSetting, setSetting } from "@/lib/repos/visibility";

const CICO_KEY = "cico_profiles";
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export interface CicoProfile {
  name: string;
  archived: boolean;
  /** UTC weekdays (0=Sun..6=Sat) on which check-in is allowed. */
  allowedCheckin: number[];
  /** UTC weekdays on which check-out is allowed. */
  allowedCheckout: number[];
}

const validDays = (xs: unknown): number[] => {
  const days = Array.isArray(xs)
    ? [...new Set(xs.map((x) => Math.round(Number(x))).filter((x) => x >= 0 && x <= 6))]
    : [];
  return days.length ? days.sort() : ALL_DAYS;
};

export function listCicoProfiles(includeArchived = false): CicoProfile[] {
  const raw = getSetting(CICO_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as CicoProfile[];
    if (!Array.isArray(arr)) return [];
    const all = arr
      .filter((p) => p && typeof p.name === "string" && p.name.trim() !== "")
      .map((p) => ({
        name: p.name.trim().slice(0, 60),
        archived: !!p.archived,
        allowedCheckin: validDays(p.allowedCheckin),
        allowedCheckout: validDays(p.allowedCheckout),
      }));
    return includeArchived ? all : all.filter((p) => !p.archived);
  } catch {
    return [];
  }
}

export function findCicoProfile(name: string | null | undefined): CicoProfile | null {
  if (!name) return null;
  return listCicoProfiles(true).find((p) => p.name === name) ?? null;
}

/** Create or update a profile (matched by name). */
export function upsertCicoProfile(p: {
  name: string;
  allowedCheckin: number[];
  allowedCheckout: number[];
}): CicoProfile[] {
  const name = p.name.trim().slice(0, 60);
  if (!name) throw new Error("profile name required");
  const all = listCicoProfiles(true);
  const existing = all.find((x) => x.name === name);
  const next: CicoProfile = {
    name,
    archived: existing?.archived ?? false,
    allowedCheckin: validDays(p.allowedCheckin),
    allowedCheckout: validDays(p.allowedCheckout),
  };
  const out = existing ? all.map((x) => (x.name === name ? next : x)) : [...all, next];
  setSetting(CICO_KEY, JSON.stringify(out));
  return out;
}

/** Archive/unarchive — PriceLabs has no delete; an attached archived profile
 *  stays in effect, it's just hidden from the picker. */
export function setCicoArchived(name: string, archived: boolean): CicoProfile[] {
  const all = listCicoProfiles(true);
  if (!all.some((p) => p.name === name)) throw new Error(`unknown profile "${name}"`);
  const out = all.map((p) => (p.name === name ? { ...p, archived } : p));
  setSetting(CICO_KEY, JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------------------
// Generic named-payload profiles, same lifecycle as CICO (upsert by name,
// archive instead of delete, archived-but-attached keeps applying). Used for
// Min Stay Profiles (a full minStayRules payload) and custom OBA profiles
// (a windows matrix). Updating a profile automatically propagates to every
// scope it's attached to, because attachment stores only the NAME and the
// payload resolves at read time.

export interface NamedProfile<T> {
  name: string;
  archived: boolean;
  payload: T;
}

function listNamed<T>(key: string, includeArchived: boolean): NamedProfile<T>[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as NamedProfile<T>[];
    if (!Array.isArray(arr)) return [];
    const all = arr.filter((p) => p && typeof p.name === "string" && p.name.trim() !== "");
    return includeArchived ? all : all.filter((p) => !p.archived);
  } catch {
    return [];
  }
}

function upsertNamed<T>(key: string, name: string, payload: T): NamedProfile<T>[] {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("profile name required");
  const all = listNamed<T>(key, true);
  const existing = all.find((p) => p.name === n);
  const next: NamedProfile<T> = { name: n, archived: existing?.archived ?? false, payload };
  const out = existing ? all.map((p) => (p.name === n ? next : p)) : [...all, next];
  setSetting(key, JSON.stringify(out));
  return out;
}

function archiveNamed<T>(key: string, name: string, archived: boolean): NamedProfile<T>[] {
  const all = listNamed<T>(key, true);
  if (!all.some((p) => p.name === name)) throw new Error(`unknown profile "${name}"`);
  const out = all.map((p) => (p.name === name ? { ...p, archived } : p));
  setSetting(key, JSON.stringify(out));
  return out;
}

const MIN_STAY_KEY = "min_stay_profiles";
const OBA_KEY = "oba_profiles";

/** Min Stay Profile payload: the minStayRules section sans `profile` (a profile
 *  can't reference another profile). */
export type MinStayProfilePayload = Record<string, unknown>;

export const listMinStayProfiles = (includeArchived = false) =>
  listNamed<MinStayProfilePayload>(MIN_STAY_KEY, includeArchived);
export const findMinStayProfile = (name: string | null | undefined) =>
  name ? (listMinStayProfiles(true).find((p) => p.name === name) ?? null) : null;
export const upsertMinStayProfile = (name: string, payload: MinStayProfilePayload) =>
  upsertNamed(MIN_STAY_KEY, name, payload);
export const setMinStayProfileArchived = (name: string, archived: boolean) =>
  archiveNamed<MinStayProfilePayload>(MIN_STAY_KEY, name, archived);

/** Custom OBA profile payload: a booking-window band matrix. */
export interface ObaProfilePayload {
  windows: Array<{ uptoDays: number; bands: Array<{ upTo: number; adjust: number; label: string }> }>;
}

export const listObaProfiles = (includeArchived = false) =>
  listNamed<ObaProfilePayload>(OBA_KEY, includeArchived);
export const findObaProfile = (name: string | null | undefined) =>
  name ? (listObaProfiles(true).find((p) => p.name === name) ?? null) : null;
export const upsertObaProfile = (name: string, payload: ObaProfilePayload) =>
  upsertNamed(OBA_KEY, name, payload);
export const setObaProfileArchived = (name: string, archived: boolean) =>
  archiveNamed<ObaProfilePayload>(OBA_KEY, name, archived);
