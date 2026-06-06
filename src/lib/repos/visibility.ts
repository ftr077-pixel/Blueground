import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

// A search profile = the *query* (area + dates + guests). Many listings share one.
export interface SearchProfile {
  id: string;
  label: string;
  platform: string;
  guests: number;
  currency: string;
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  zoom: number;
  stayNights: number[];
  startDates: string[];
  active: boolean;
  createdAt: string;
  lastRunAt: string | null;
}

export interface TrackedListing {
  id: string;
  airbnbId: string;
  label: string;
  platform: string;
  profileId: string;
  unitId: string | null;
  minNights: number | null;
  minNightsCheckedAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface ListingSnapshot {
  id: string;
  listingId: string;
  airbnbId: string;
  profileId: string;
  runId: string;
  ts: string;
  stayLabel: string;
  nights: number;
  checkIn: string;
  checkOut: string;
  eligible: boolean;
  minNights: number | null;
  found: boolean;
  page: number | null;
  position: number | null;
  rank: number | null;
  total: number | null;
  price: number | null;
  currency: string | null;
}

interface ProfileSql {
  id: string;
  label: string;
  platform: string;
  guests: number;
  currency: string;
  sw_lat: number;
  sw_lng: number;
  ne_lat: number;
  ne_lng: number;
  zoom: number;
  stay_nights: string;
  start_dates: string;
  active: number;
  created_at: string;
  last_run_at: string | null;
}

interface ListingSql {
  id: string;
  airbnb_id: string;
  label: string;
  platform: string;
  profile_id: string;
  unit_id: string | null;
  min_nights: number | null;
  min_nights_checked_at: string | null;
  active: number;
  created_at: string;
}

interface SnapshotSql {
  id: string;
  listing_id: string;
  airbnb_id: string;
  profile_id: string;
  run_id: string;
  ts: string;
  stay_label: string;
  nights: number;
  check_in: string;
  check_out: string;
  eligible: number;
  min_nights: number | null;
  found: number;
  page: number | null;
  position: number | null;
  rank: number | null;
  total: number | null;
  price: number | null;
  currency: string | null;
}

function rowToProfile(r: ProfileSql): SearchProfile {
  return {
    id: r.id,
    label: r.label,
    platform: r.platform,
    guests: r.guests,
    currency: r.currency,
    swLat: r.sw_lat,
    swLng: r.sw_lng,
    neLat: r.ne_lat,
    neLng: r.ne_lng,
    zoom: r.zoom,
    stayNights: JSON.parse(r.stay_nights) as number[],
    startDates: JSON.parse(r.start_dates) as string[],
    active: !!r.active,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  };
}

function rowToListing(r: ListingSql): TrackedListing {
  return {
    id: r.id,
    airbnbId: r.airbnb_id,
    label: r.label,
    platform: r.platform,
    profileId: r.profile_id,
    unitId: r.unit_id,
    minNights: r.min_nights,
    minNightsCheckedAt: r.min_nights_checked_at,
    active: !!r.active,
    createdAt: r.created_at,
  };
}

function rowToSnapshot(r: SnapshotSql): ListingSnapshot {
  return {
    id: r.id,
    listingId: r.listing_id,
    airbnbId: r.airbnb_id,
    profileId: r.profile_id,
    runId: r.run_id,
    ts: r.ts,
    stayLabel: r.stay_label,
    nights: r.nights,
    checkIn: r.check_in,
    checkOut: r.check_out,
    eligible: !!r.eligible,
    minNights: r.min_nights,
    found: !!r.found,
    page: r.page,
    position: r.position,
    rank: r.rank,
    total: r.total,
    price: r.price,
    currency: r.currency,
  };
}

// ---------------------------------------------------------------- profiles
export interface ProfileInput {
  label: string;
  platform?: string;
  guests?: number;
  currency?: string;
  swLat?: number;
  swLng?: number;
  neLat?: number;
  neLng?: number;
  zoom?: number;
  stayNights?: number[];
  startDates?: string[];
  active?: boolean;
}

export function listProfiles(): SearchProfile[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM search_profiles ORDER BY created_at").all() as ProfileSql[]).map(
    rowToProfile,
  );
}

export function getProfile(id: string): SearchProfile | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM search_profiles WHERE id = ?").get(id) as ProfileSql | undefined;
  return r ? rowToProfile(r) : null;
}

export function createProfile(input: ProfileInput): SearchProfile {
  const db = getDb();
  const id = "prof-" + randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO search_profiles
      (id, label, platform, guests, currency, sw_lat, sw_lng, ne_lat, ne_lng, zoom, stay_nights, start_dates, active, created_at, last_run_at)
     VALUES
      (@id, @label, @platform, @guests, @currency, @sw_lat, @sw_lng, @ne_lat, @ne_lng, @zoom, @stay_nights, @start_dates, @active, @created_at, NULL)`,
  ).run({
    id,
    label: input.label,
    platform: input.platform ?? "Airbnb",
    guests: input.guests ?? 2,
    currency: input.currency ?? "ILS",
    sw_lat: input.swLat ?? 32.04,
    sw_lng: input.swLng ?? 34.74,
    ne_lat: input.neLat ?? 32.12,
    ne_lng: input.neLng ?? 34.83,
    zoom: input.zoom ?? 14,
    stay_nights: JSON.stringify(input.stayNights ?? [7, 14, 30]),
    start_dates: JSON.stringify(input.startDates ?? []),
    active: input.active === false ? 0 : 1,
    created_at: new Date().toISOString(),
  });
  return getProfile(id)!;
}

export function updateProfile(id: string, patch: Partial<ProfileInput>): void {
  const db = getDb();
  const cur = getProfile(id);
  if (!cur) return;
  db.prepare(
    `UPDATE search_profiles SET label=@label, platform=@platform, guests=@guests, currency=@currency,
       sw_lat=@sw_lat, sw_lng=@sw_lng, ne_lat=@ne_lat, ne_lng=@ne_lng, zoom=@zoom,
       stay_nights=@stay_nights, start_dates=@start_dates, active=@active WHERE id=@id`,
  ).run({
    id,
    label: patch.label ?? cur.label,
    platform: patch.platform ?? cur.platform,
    guests: patch.guests ?? cur.guests,
    currency: patch.currency ?? cur.currency,
    sw_lat: patch.swLat ?? cur.swLat,
    sw_lng: patch.swLng ?? cur.swLng,
    ne_lat: patch.neLat ?? cur.neLat,
    ne_lng: patch.neLng ?? cur.neLng,
    zoom: patch.zoom ?? cur.zoom,
    stay_nights: JSON.stringify(patch.stayNights ?? cur.stayNights),
    start_dates: JSON.stringify(patch.startDates ?? cur.startDates),
    active: (patch.active ?? cur.active) ? 1 : 0,
  });
}

export function deleteProfile(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM listing_snapshots WHERE profile_id = ?").run(id);
    db.prepare("DELETE FROM tracked_listings WHERE profile_id = ?").run(id);
    db.prepare("DELETE FROM search_profiles WHERE id = ?").run(id);
  });
  tx();
}

// ---------------------------------------------------------------- listings
export interface ListingInput {
  airbnbId: string;
  label?: string;
  profileId: string;
  platform?: string;
  unitId?: string | null;
}

export function getListing(id: string): TrackedListing | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM tracked_listings WHERE id = ?").get(id) as ListingSql | undefined;
  return r ? rowToListing(r) : null;
}

export function listListings(): TrackedListing[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM tracked_listings ORDER BY created_at").all() as ListingSql[]).map(
    rowToListing,
  );
}

export function listListingsByProfile(profileId: string): TrackedListing[] {
  const db = getDb();
  return (
    db.prepare("SELECT * FROM tracked_listings WHERE profile_id = ? ORDER BY created_at").all(
      profileId,
    ) as ListingSql[]
  ).map(rowToListing);
}

export function createListing(input: ListingInput): TrackedListing {
  const db = getDb();
  const id = "lst-" + randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO tracked_listings
      (id, airbnb_id, label, platform, profile_id, unit_id, min_nights, min_nights_checked_at, active, created_at)
     VALUES
      (@id, @airbnb_id, @label, @platform, @profile_id, @unit_id, NULL, NULL, 1, @created_at)`,
  ).run({
    id,
    airbnb_id: input.airbnbId,
    label: input.label && input.label.trim() ? input.label.trim() : `Listing ${input.airbnbId}`,
    platform: input.platform ?? "Airbnb",
    profile_id: input.profileId,
    unit_id: input.unitId ?? null,
    created_at: new Date().toISOString(),
  });
  return getListing(id)!;
}

export function updateListing(
  id: string,
  patch: { label?: string; active?: boolean; profileId?: string },
): void {
  const db = getDb();
  const cur = getListing(id);
  if (!cur) return;
  db.prepare(
    "UPDATE tracked_listings SET label=@label, active=@active, profile_id=@profile_id WHERE id=@id",
  ).run({
    id,
    label: patch.label ?? cur.label,
    active: (patch.active ?? cur.active) ? 1 : 0,
    profile_id: patch.profileId ?? cur.profileId,
  });
}

export function deleteListing(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM listing_snapshots WHERE listing_id = ?").run(id);
    db.prepare("DELETE FROM tracked_listings WHERE id = ?").run(id);
  });
  tx();
}

// Parse pasted Airbnb IDs / room URLs (one per line), optional label after the id.
export function parseListingLines(text: string): Array<{ airbnbId: string; label?: string }> {
  const out: Array<{ airbnbId: string; label?: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let id: string | null = null;
    const roomMatch = line.match(/rooms\/(\d+)/);
    if (roomMatch) {
      id = roomMatch[1];
    } else {
      const digits = line.match(/\d{6,}/);
      if (digits) id = digits[0];
    }
    if (!id) continue;
    const label = line
      .replace(/https?:\/\/\S+/g, "")
      .replace(id, "")
      .replace(/^[\s,|–-]+/, "")
      .trim();
    out.push({ airbnbId: id, label: label || undefined });
  }
  return out;
}

export function createListingsBulk(profileId: string, text: string): number {
  const db = getDb();
  const parsed = parseListingLines(text);
  const tx = db.transaction(() => {
    for (const p of parsed) createListing({ airbnbId: p.airbnbId, label: p.label, profileId });
  });
  tx();
  return parsed.length;
}

// ---------------------------------------------------------------- snapshots
export interface RecordRunInput {
  profileId: string;
  runId: string;
  snapshots: Array<{
    listingId: string;
    airbnbId?: string;
    stayLabel: string;
    nights: number;
    checkIn: string;
    checkOut: string;
    eligible: boolean;
    minNights?: number | null;
    found: boolean;
    page?: number | null;
    position?: number | null;
    rank?: number | null;
    total?: number | null;
    price?: number | null;
    currency?: string | null;
  }>;
  listingMinNights?: Record<string, number | null>;
}

export function recordRun(input: RecordRunInput): number {
  const db = getDb();
  const ts = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO listing_snapshots
      (id, listing_id, airbnb_id, profile_id, run_id, ts, stay_label, nights, check_in, check_out, eligible, min_nights, found, page, position, rank, total, price, currency)
     VALUES
      (@id, @listing_id, @airbnb_id, @profile_id, @run_id, @ts, @stay_label, @nights, @check_in, @check_out, @eligible, @min_nights, @found, @page, @position, @rank, @total, @price, @currency)`,
  );
  const tx = db.transaction(() => {
    for (const s of input.snapshots) {
      ins.run({
        id: randomUUID(),
        listing_id: s.listingId,
        airbnb_id: s.airbnbId ?? "",
        profile_id: input.profileId,
        run_id: input.runId,
        ts,
        stay_label: s.stayLabel,
        nights: s.nights,
        check_in: s.checkIn,
        check_out: s.checkOut,
        eligible: s.eligible ? 1 : 0,
        min_nights: s.minNights ?? null,
        found: s.found ? 1 : 0,
        page: s.page ?? null,
        position: s.position ?? null,
        rank: s.rank ?? null,
        total: s.total ?? null,
        price: s.price ?? null,
        currency: s.currency ?? null,
      });
    }
    db.prepare("UPDATE search_profiles SET last_run_at = ? WHERE id = ?").run(ts, input.profileId);
    if (input.listingMinNights) {
      const upd = db.prepare(
        "UPDATE tracked_listings SET min_nights = ?, min_nights_checked_at = ? WHERE id = ?",
      );
      for (const [lid, mn] of Object.entries(input.listingMinNights)) upd.run(mn ?? null, ts, lid);
    }
  });
  tx();
  return input.snapshots.length;
}

export function latestSnapshots(listingId: string): ListingSnapshot[] {
  const db = getDb();
  const row = db
    .prepare("SELECT run_id FROM listing_snapshots WHERE listing_id = ? ORDER BY ts DESC LIMIT 1")
    .get(listingId) as { run_id: string } | undefined;
  if (!row) return [];
  return (
    db
      .prepare(
        "SELECT * FROM listing_snapshots WHERE listing_id = ? AND run_id = ? ORDER BY nights, check_in",
      )
      .all(listingId, row.run_id) as SnapshotSql[]
  ).map(rowToSnapshot);
}

export function recentSnapshots(listingId: string, limit = 300): ListingSnapshot[] {
  const db = getDb();
  return (
    db
      .prepare("SELECT * FROM listing_snapshots WHERE listing_id = ? ORDER BY ts DESC LIMIT ?")
      .all(listingId, limit) as SnapshotSql[]
  ).map(rowToSnapshot);
}

// ---------------------------------------------------------------- composed views
export function getDashboard() {
  const profiles = listProfiles();
  const listings = listListings().map((l) => ({ ...l, latest: latestSnapshots(l.id) }));
  return { profiles, listings };
}

// What the scraper box pulls: active profiles, each with its active listings.
export function getScanConfig() {
  return listProfiles()
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      label: p.label,
      platform: p.platform,
      guests: p.guests,
      currency: p.currency,
      box: { swLat: p.swLat, swLng: p.swLng, neLat: p.neLat, neLng: p.neLng, zoom: p.zoom },
      stayNights: p.stayNights,
      startDates: p.startDates,
      listings: listListingsByProfile(p.id)
        .filter((l) => l.active)
        .map((l) => ({
          id: l.id,
          airbnbId: l.airbnbId,
          label: l.label,
          minNights: l.minNights,
          minNightsCheckedAt: l.minNightsCheckedAt,
        })),
    }));
}
