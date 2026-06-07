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
  dateMode: string;
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
  guests: number | null; // per-apartment override; null = use profile default
  startDates: string[] | null; // per-apartment override; null = use profile dates
  minNights: number | null;
  minNightsCheckedAt: string | null;
  monthlyRent: number | null;
  utilities: number | null;
  cleaningFee: number | null;
  address: string | null;
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
  available: boolean | null;
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
  date_mode: string | null;
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
  guests: number | null;
  start_dates: string | null;
  min_nights: number | null;
  min_nights_checked_at: string | null;
  monthly_rent: number | null;
  utilities: number | null;
  cleaning_fee: number | null;
  address: string | null;
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
  available: number | null;
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
    dateMode: r.date_mode || "fixed",
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
    guests: r.guests,
    startDates: r.start_dates ? (JSON.parse(r.start_dates) as string[]) : null,
    minNights: r.min_nights,
    minNightsCheckedAt: r.min_nights_checked_at,
    monthlyRent: r.monthly_rent,
    utilities: r.utilities,
    cleaningFee: r.cleaning_fee,
    address: r.address,
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
    available: r.available == null ? null : !!r.available,
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
  dateMode?: string;
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
      (id, label, platform, guests, currency, sw_lat, sw_lng, ne_lat, ne_lng, zoom, stay_nights, start_dates, date_mode, active, created_at, last_run_at)
     VALUES
      (@id, @label, @platform, @guests, @currency, @sw_lat, @sw_lng, @ne_lat, @ne_lng, @zoom, @stay_nights, @start_dates, @date_mode, @active, @created_at, NULL)`,
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
    date_mode: input.dateMode ?? "fixed",
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
       stay_nights=@stay_nights, start_dates=@start_dates, date_mode=@date_mode, active=@active WHERE id=@id`,
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
    date_mode: patch.dateMode ?? cur.dateMode,
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
  guests?: number | null;
  startDates?: string[] | null;
  monthlyRent?: number | null;
  utilities?: number | null;
  cleaningFee?: number | null;
  address?: string | null;
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
      (id, airbnb_id, label, platform, profile_id, unit_id, guests, start_dates, min_nights, min_nights_checked_at, monthly_rent, utilities, cleaning_fee, address, active, created_at)
     VALUES
      (@id, @airbnb_id, @label, @platform, @profile_id, @unit_id, @guests, @start_dates, NULL, NULL, @monthly_rent, @utilities, @cleaning_fee, @address, 1, @created_at)`,
  ).run({
    id,
    airbnb_id: input.airbnbId,
    label: input.label && input.label.trim() ? input.label.trim() : `Listing ${input.airbnbId}`,
    platform: input.platform ?? "Airbnb",
    profile_id: input.profileId,
    unit_id: input.unitId ?? null,
    guests: input.guests ?? null,
    start_dates:
      input.startDates && input.startDates.length ? JSON.stringify(input.startDates) : null,
    monthly_rent: input.monthlyRent ?? null,
    utilities: input.utilities ?? null,
    cleaning_fee: input.cleaningFee ?? null,
    address: input.address ?? null,
    created_at: new Date().toISOString(),
  });
  return getListing(id)!;
}

export function updateListing(
  id: string,
  patch: {
    label?: string;
    active?: boolean;
    profileId?: string;
    guests?: number | null;
    startDates?: string[] | null;
    monthlyRent?: number | null;
    utilities?: number | null;
    cleaningFee?: number | null;
    address?: string | null;
  },
): void {
  const db = getDb();
  const cur = getListing(id);
  if (!cur) return;
  const guests = patch.guests !== undefined ? patch.guests : cur.guests;
  const startDates = patch.startDates !== undefined ? patch.startDates : cur.startDates;
  const monthlyRent = patch.monthlyRent !== undefined ? patch.monthlyRent : cur.monthlyRent;
  const utilities = patch.utilities !== undefined ? patch.utilities : cur.utilities;
  const cleaningFee = patch.cleaningFee !== undefined ? patch.cleaningFee : cur.cleaningFee;
  const address = patch.address !== undefined ? patch.address : cur.address;
  db.prepare(
    `UPDATE tracked_listings SET label=@label, active=@active, profile_id=@profile_id,
       guests=@guests, start_dates=@start_dates, monthly_rent=@monthly_rent,
       utilities=@utilities, cleaning_fee=@cleaning_fee, address=@address WHERE id=@id`,
  ).run({
    id,
    label: patch.label ?? cur.label,
    active: (patch.active ?? cur.active) ? 1 : 0,
    profile_id: patch.profileId ?? cur.profileId,
    guests: guests ?? null,
    start_dates: startDates && startDates.length ? JSON.stringify(startDates) : null,
    monthly_rent: monthlyRent ?? null,
    utilities: utilities ?? null,
    cleaning_fee: cleaningFee ?? null,
    address: address ?? null,
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

// Bulk-set rent (and address) from pasted rows. Each row is
// "[index] <key> <rent>" (tab- or space-separated). The key is an Airbnb ID
// (matched exactly) or a listing name/address (matched against the label,
// ignoring case/punctuation). Unmatched rows are returned for review.
function parseImportRow(line: string): { key: string; rent: number } | null {
  const cells = (line.includes("\t") ? line.split("\t") : line.split(/\s+/))
    .map((c) => c.trim())
    .filter(Boolean);
  if (cells.length < 2) return null;
  const rent = parseFloat(cells[cells.length - 1].replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(rent)) return null;
  let rest = cells.slice(0, -1);
  if (rest.length >= 2 && /^\d{1,4}$/.test(rest[0])) rest = rest.slice(1); // drop leading row index
  const key = (line.includes("\t") ? rest[rest.length - 1] : rest.join(" ")).trim();
  return key ? { key, rent } : null;
}

export function bulkSetRentAddress(text: string): { updated: number; unmatched: string[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const listings = listListings();
  const byAirbnb = new Map<string, TrackedListing>();
  const byName = new Map<string, TrackedListing[]>();
  for (const l of listings) {
    byAirbnb.set(String(l.airbnbId), l);
    const k = norm(l.label);
    const arr = byName.get(k) ?? [];
    arr.push(l);
    byName.set(k, arr);
  }

  let updated = 0;
  const unmatched: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const row = parseImportRow(line);
    if (!row) {
      unmatched.push(line);
      continue;
    }
    let target: TrackedListing | undefined;
    let address: string | null = row.key;
    if (/^\d{7,}$/.test(row.key)) {
      target = byAirbnb.get(row.key);
      address = null; // key is an id, not an address
    } else {
      const m = byName.get(norm(row.key));
      if (m && m.length === 1) target = m[0];
    }
    if (!target) {
      unmatched.push(line);
      continue;
    }
    updateListing(target.id, { monthlyRent: row.rent, ...(address ? { address } : {}) });
    updated++;
  }
  return { updated, unmatched };
}

// Parse pasted listings — one per line. Handles plain Airbnb IDs, room URLs, and
// CSV rows (e.g. exported from a sheet): it finds the id/url cell and uses another
// cell as the label. A header row (no id) is skipped automatically.
export function parseListingLines(text: string): Array<{ airbnbId: string; label?: string }> {
  const out: Array<{ airbnbId: string; label?: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line
      .split(/[,\t;]/)
      .map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());

    let id: string | null = null;
    for (const c of cells) {
      const m = c.match(/rooms\/(\d+)/);
      if (m) {
        id = m[1];
        break;
      }
    }
    if (!id) {
      for (const c of cells) {
        if (/^\d{6,}$/.test(c)) {
          id = c;
          break;
        }
      }
    }
    if (!id) continue;

    const label = cells.find(
      (c) => c && !c.includes("airbnb.") && !c.includes("rooms/") && !/^\d{4,}$/.test(c),
    );
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
    available?: boolean | null;
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
      (id, listing_id, airbnb_id, profile_id, run_id, ts, stay_label, nights, check_in, check_out, eligible, min_nights, found, available, page, position, rank, total, price, currency)
     VALUES
      (@id, @listing_id, @airbnb_id, @profile_id, @run_id, @ts, @stay_label, @nights, @check_in, @check_out, @eligible, @min_nights, @found, @available, @page, @position, @rank, @total, @price, @currency)`,
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
        available: s.available == null ? null : s.available ? 1 : 0,
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
  const num = (k: string, d: number) => {
    const v = getSetting(k);
    return v != null && v !== "" ? Number(v) : d;
  };
  return {
    profiles,
    listings,
    primaryStay: num("primary_stay", 30),
    costDefaults: {
      bgFeePct: num("bg_fee_pct", 6),
      defaultUtilities: num("default_utilities", 1000),
      defaultCleaning: num("default_cleaning", 500),
    },
  };
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
      dateMode: p.dateMode,
      listings: listListingsByProfile(p.id)
        .filter((l) => l.active)
        .map((l) => ({
          id: l.id,
          airbnbId: l.airbnbId,
          label: l.label,
          // effective values: per-apartment override, else the profile default
          guests: l.guests ?? p.guests,
          startDates: l.startDates && l.startDates.length ? l.startDates : p.startDates,
          minNights: l.minNights,
          minNightsCheckedAt: l.minNightsCheckedAt,
        })),
    }));
}

// ---------------------------------------------------------------- settings
export function getSetting(key: string): string | null {
  const db = getDb();
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(`setting:${key}`) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`setting:${key}`, value);
}

// ---------------------------------------------------------------- scan state
export interface ScanState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export function getScanState(): ScanState {
  const started = getSetting("scan_running");
  let running = !!started;
  if (started) {
    const age = Date.now() - new Date(started).getTime();
    if (Number.isNaN(age) || age > 30 * 60 * 1000) running = false; // stale-run guard
  }
  return {
    running,
    startedAt: started || null,
    finishedAt: getSetting("scan_finished_at"),
    message: getSetting("scan_message"),
  };
}

export function markScanStarted(): void {
  setSetting("scan_running", new Date().toISOString());
  setSetting("scan_message", "scanning…");
}

export function markScanFinished(message: string): void {
  setSetting("scan_running", "");
  setSetting("scan_finished_at", new Date().toISOString());
  setSetting("scan_message", message);
}

// ---------------------------------------------------------------- analytics
export interface TrendPoint {
  runId: string;
  ts: string;
  listings: number;
  appearing: number;
  page1: number;
  available: number;
}

// Per-scan portfolio counts over time (one point per run, chronological).
export function portfolioTrend(limitRuns = 90): TrendPoint[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH per_listing AS (
         SELECT run_id, listing_id,
           MAX(found) AS appeared,
           MAX(CASE WHEN page = 1 THEN 1 ELSE 0 END) AS p1,
           MAX(CASE WHEN found = 1 OR available = 1 THEN 1 ELSE 0 END) AS avail
         FROM listing_snapshots GROUP BY run_id, listing_id
       ),
       run_ts AS (SELECT run_id, MAX(ts) AS ts FROM listing_snapshots GROUP BY run_id)
       SELECT pl.run_id AS runId, rt.ts AS ts,
         COUNT(*) AS listings,
         SUM(pl.appeared) AS appearing,
         SUM(pl.p1) AS page1,
         SUM(pl.avail) AS available
       FROM per_listing pl JOIN run_ts rt ON rt.run_id = pl.run_id
       GROUP BY pl.run_id ORDER BY rt.ts DESC LIMIT ?`,
    )
    .all(limitRuns) as TrendPoint[];
  return rows.reverse();
}

export interface Mover {
  listingId: string;
  label: string;
  airbnbId: string;
  latestRank: number | null;
  prevRank: number | null;
  delta: number | null; // positive = climbed (rank got smaller)
  kind: "up" | "down" | "entered" | "left";
}

export function computeMovers(limit = 40): Mover[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT listing_id AS listingId, run_id AS runId, MAX(ts) AS ts,
         MIN(CASE WHEN found = 1 THEN rank END) AS bestRank
       FROM listing_snapshots GROUP BY listing_id, run_id`,
    )
    .all() as Array<{ listingId: string; runId: string; ts: string; bestRank: number | null }>;

  const byListing = new Map<string, Array<{ ts: string; bestRank: number | null }>>();
  for (const r of rows) {
    const arr = byListing.get(r.listingId) ?? [];
    arr.push({ ts: r.ts, bestRank: r.bestRank });
    byListing.set(r.listingId, arr);
  }
  const listings = new Map(listListings().map((l) => [l.id, l]));

  const movers: Mover[] = [];
  for (const [lid, runs] of byListing) {
    if (runs.length < 2) continue;
    runs.sort((a, b) => a.ts.localeCompare(b.ts));
    const latest = runs[runs.length - 1];
    const prev = runs[runs.length - 2];
    const l = listings.get(lid);
    if (!l) continue;
    const base = {
      listingId: lid,
      label: l.label,
      airbnbId: l.airbnbId,
      latestRank: latest.bestRank,
      prevRank: prev.bestRank,
    };
    if (latest.bestRank != null && prev.bestRank != null) {
      const delta = prev.bestRank - latest.bestRank;
      if (delta !== 0) movers.push({ ...base, delta, kind: delta > 0 ? "up" : "down" });
    } else if (latest.bestRank != null && prev.bestRank == null) {
      movers.push({ ...base, delta: null, kind: "entered" });
    } else if (latest.bestRank == null && prev.bestRank != null) {
      movers.push({ ...base, delta: null, kind: "left" });
    }
  }
  movers.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  return movers.slice(0, limit);
}

// ---------------------------------------------------------------- comp-set / market data
// Our home-grown analog to PriceLabs' "Neighborhood Data": percentile nightly
// rate bands derived from the competitor prices we already scrape. Snapshot
// `price` is the total for the stay, so nightly = price / nights.
export interface RateBand {
  profileId: string;
  area: string; // profile label
  nights: number;
  stayLabel: string;
  n: number;
  p25: number; // nightly, in `currency`
  p50: number;
  p75: number;
  currency: string;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function marketRateBands(): RateBand[] {
  const db = getDb();
  // Most-recent priced appearance per (listing, nights), so a frequently-scanned
  // listing isn't over-counted; then group by search area (profile) × stay length.
  const rows = db
    .prepare(
      `SELECT listing_id, profile_id, nights, stay_label, price, currency
       FROM listing_snapshots
       WHERE found = 1 AND price IS NOT NULL AND price > 0 AND nights > 0
       ORDER BY ts DESC`,
    )
    .all() as Array<{
    listing_id: string;
    profile_id: string;
    nights: number;
    stay_label: string;
    price: number;
    currency: string | null;
  }>;

  const profiles = new Map(listProfiles().map((p) => [p.id, p]));
  const seen = new Set<string>();
  const groups = new Map<
    string,
    { profileId: string; nights: number; stayLabel: string; currency: string; nightly: number[] }
  >();
  for (const r of rows) {
    const dedupe = `${r.listing_id}::${r.nights}`;
    if (seen.has(dedupe)) continue; // keep only the latest per listing×nights
    seen.add(dedupe);
    const key = `${r.profile_id}::${r.nights}`;
    const g =
      groups.get(key) ??
      {
        profileId: r.profile_id,
        nights: r.nights,
        stayLabel: r.stay_label,
        currency: r.currency ?? "ILS",
        nightly: [],
      };
    g.nightly.push(r.price / r.nights);
    groups.set(key, g);
  }

  const bands: RateBand[] = [];
  for (const g of groups.values()) {
    const sorted = [...g.nightly].sort((a, b) => a - b);
    bands.push({
      profileId: g.profileId,
      area: profiles.get(g.profileId)?.label ?? g.profileId,
      nights: g.nights,
      stayLabel: g.stayLabel,
      n: sorted.length,
      p25: Math.round(percentile(sorted, 0.25)),
      p50: Math.round(percentile(sorted, 0.5)),
      p75: Math.round(percentile(sorted, 0.75)),
      currency: g.currency,
    });
  }
  bands.sort((a, b) => a.area.localeCompare(b.area) || a.nights - b.nights);
  return bands;
}

// Median competitor minimum-stay across tracked listings — a benchmark the
// Pricing Specialist uses when recommending our own min-stay.
export function marketMinNightsBenchmark(): { median: number | null; n: number } {
  const db = getDb();
  const rows = db
    .prepare("SELECT min_nights FROM tracked_listings WHERE min_nights IS NOT NULL")
    .all() as Array<{ min_nights: number }>;
  const vals = rows.map((r) => r.min_nights).filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return { median: null, n: 0 };
  const mid = Math.floor(vals.length / 2);
  const median =
    vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  return { median, n: vals.length };
}

export interface HistoryPoint {
  runId: string;
  ts: string;
  bestRank: number | null;
  bestPage: number | null;
  price: number | null;
  available: boolean;
}

export function listingHistory(listingId: string): HistoryPoint[] {
  const snaps = recentSnapshots(listingId, 3000);
  const byRun = new Map<string, ListingSnapshot[]>();
  for (const s of snaps) {
    const arr = byRun.get(s.runId) ?? [];
    arr.push(s);
    byRun.set(s.runId, arr);
  }
  const points: HistoryPoint[] = [];
  for (const [runId, rows] of byRun) {
    const ts = rows.reduce((m, r) => (r.ts > m ? r.ts : m), rows[0].ts);
    const found = rows.filter((r) => r.found && r.rank != null);
    const bestRow = found.length
      ? found.reduce((b, r) => ((r.rank as number) < (b.rank as number) ? r : b))
      : null;
    const price = bestRow?.price ?? rows.find((r) => r.price != null)?.price ?? null;
    points.push({
      runId,
      ts,
      bestRank: bestRow?.rank ?? null,
      bestPage: bestRow?.page ?? null,
      price,
      available: rows.some((r) => r.available === true || r.found),
    });
  }
  points.sort((a, b) => a.ts.localeCompare(b.ts));
  return points;
}
