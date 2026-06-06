import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export interface TrackedSearch {
  id: string;
  listingId: string;
  label: string;
  platform: string;
  unitId: string | null;
  guests: number;
  currency: string;
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  zoom: number;
  stayNights: number[];
  startDates: string[];
  minNights: number | null;
  active: boolean;
  createdAt: string;
  lastRunAt: string | null;
}

export interface RankSnapshot {
  id: string;
  searchId: string;
  listingId: string;
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

interface TrackedSearchSql {
  id: string;
  listing_id: string;
  label: string;
  platform: string;
  unit_id: string | null;
  guests: number;
  currency: string;
  sw_lat: number;
  sw_lng: number;
  ne_lat: number;
  ne_lng: number;
  zoom: number;
  stay_nights: string;
  start_dates: string;
  min_nights: number | null;
  active: number;
  created_at: string;
  last_run_at: string | null;
}

interface RankSnapshotSql {
  id: string;
  search_id: string;
  listing_id: string;
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

function rowToSearch(r: TrackedSearchSql): TrackedSearch {
  return {
    id: r.id,
    listingId: r.listing_id,
    label: r.label,
    platform: r.platform,
    unitId: r.unit_id,
    guests: r.guests,
    currency: r.currency,
    swLat: r.sw_lat,
    swLng: r.sw_lng,
    neLat: r.ne_lat,
    neLng: r.ne_lng,
    zoom: r.zoom,
    stayNights: JSON.parse(r.stay_nights) as number[],
    startDates: JSON.parse(r.start_dates) as string[],
    minNights: r.min_nights,
    active: !!r.active,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  };
}

function rowToSnapshot(r: RankSnapshotSql): RankSnapshot {
  return {
    id: r.id,
    searchId: r.search_id,
    listingId: r.listing_id,
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

export function listTrackedSearches(activeOnly = false): TrackedSearch[] {
  const db = getDb();
  const sql = activeOnly
    ? "SELECT * FROM tracked_searches WHERE active = 1 ORDER BY created_at"
    : "SELECT * FROM tracked_searches ORDER BY created_at";
  return (db.prepare(sql).all() as TrackedSearchSql[]).map(rowToSearch);
}

export function latestRunId(searchId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT run_id FROM rank_snapshots WHERE search_id = ? ORDER BY ts DESC LIMIT 1")
    .get(searchId) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export function snapshotsByRun(searchId: string, runId: string): RankSnapshot[] {
  const db = getDb();
  return (
    db
      .prepare(
        "SELECT * FROM rank_snapshots WHERE search_id = ? AND run_id = ? ORDER BY nights, check_in",
      )
      .all(searchId, runId) as RankSnapshotSql[]
  ).map(rowToSnapshot);
}

export function recentSnapshots(searchId: string, limit = 200): RankSnapshot[] {
  const db = getDb();
  return (
    db
      .prepare("SELECT * FROM rank_snapshots WHERE search_id = ? ORDER BY ts DESC LIMIT ?")
      .all(searchId, limit) as RankSnapshotSql[]
  ).map(rowToSnapshot);
}

export interface RecordRunInput {
  searchId: string;
  runId: string;
  listingId?: string;
  minNights?: number | null;
  snapshots: Array<{
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
}

export function recordRun(input: RecordRunInput): number {
  const db = getDb();
  const ts = new Date().toISOString();
  const listingId = input.listingId ?? "";
  const insert = db.prepare(`
    INSERT INTO rank_snapshots
      (id, search_id, listing_id, run_id, ts, stay_label, nights, check_in, check_out, eligible, min_nights, found, page, position, rank, total, price, currency)
    VALUES
      (@id, @search_id, @listing_id, @run_id, @ts, @stay_label, @nights, @check_in, @check_out, @eligible, @min_nights, @found, @page, @position, @rank, @total, @price, @currency)
  `);
  const tx = db.transaction(() => {
    for (const s of input.snapshots) {
      insert.run({
        id: randomUUID(),
        search_id: input.searchId,
        listing_id: listingId,
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
    db.prepare(
      "UPDATE tracked_searches SET last_run_at = ?, min_nights = COALESCE(?, min_nights) WHERE id = ?",
    ).run(ts, input.minNights ?? null, input.searchId);
  });
  tx();
  return input.snapshots.length;
}
