import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";

// Airbnb's web UI shows ~18 results/page; the scraper uses the same constant so
// global rank ↔ (page, position) stay consistent across the app.
const WEB_PAGE_SIZE = 18;

// One search's full competitor ladder: every result's price at its position.
// A "search" = area (profile) × check-in × stay length × guests at a moment.
export interface SearchResultsInput {
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  total: number;
  currency?: string | null;
  results: Array<{
    rank: number;
    page?: number | null;
    position?: number | null;
    roomId?: string | null;
    price?: number | null; // stay total in `currency`
  }>;
}

export interface RecordLadderInput {
  profileId: string;
  runId: string;
  ts: string;
  searches: SearchResultsInput[];
}

// Insert ladder rows on a caller-managed db handle (so it can join an existing
// transaction). Keeps run_id + ts identical to the listing_snapshots written in
// the same run, so "our row" and the market ladder line up exactly.
export function insertSearchResults(db: Database.Database, input: RecordLadderInput): number {
  const ins = db.prepare(
    `INSERT INTO search_results
       (id, profile_id, run_id, ts, check_in, check_out, nights, guests, total,
        room_id, rank, page, position, price, price_nightly, currency)
     VALUES
       (@id, @profile_id, @run_id, @ts, @check_in, @check_out, @nights, @guests, @total,
        @room_id, @rank, @page, @position, @price, @price_nightly, @currency)`,
  );
  let n = 0;
  for (const s of input.searches) {
    const nights = s.nights > 0 ? s.nights : null;
    for (const r of s.results) {
      if (r.rank == null) continue;
      // Derive page/position from rank if the scraper didn't send them, so the
      // definition lives in one place.
      const page = r.page ?? Math.floor((r.rank - 1) / WEB_PAGE_SIZE) + 1;
      const position = r.position ?? ((r.rank - 1) % WEB_PAGE_SIZE) + 1;
      const price = r.price ?? null;
      ins.run({
        id: randomUUID(),
        profile_id: input.profileId,
        run_id: input.runId,
        ts: input.ts,
        check_in: s.checkIn,
        check_out: s.checkOut,
        nights: s.nights,
        guests: s.guests,
        total: s.total,
        room_id: r.roomId ?? null,
        rank: r.rank,
        page,
        position,
        price,
        price_nightly: price != null && nights ? price / nights : null,
        currency: s.currency ?? null,
      });
      n++;
    }
  }
  return n;
}

// Standalone transactional entry point (direct ingest / tests). Within a larger
// run, recordRun() calls insertSearchResults() inside its own transaction instead.
export function recordSearchResults(input: RecordLadderInput): number {
  const db = getDb();
  let n = 0;
  const tx = db.transaction(() => {
    n = insertSearchResults(db, input);
  });
  tx();
  return n;
}

// ---------------------------------------------------------------- verification
export interface LadderRunStat {
  runId: string;
  ts: string;
  profileId: string;
  searches: number; // distinct (check_in, nights, guests) groups in the run
  rows: number;
  priced: number; // rows that carried a price
}

// Per-run ladder coverage — the M1 "debug query": confirms rows accumulate per
// scan and how many carried a price.
export function searchResultsStats(limitRuns = 20): LadderRunStat[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT run_id AS runId, MAX(ts) AS ts, profile_id AS profileId,
              COUNT(DISTINCT check_in || '|' || nights || '|' || guests) AS searches,
              COUNT(*) AS "rows",
              SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) AS priced
         FROM search_results
        GROUP BY run_id
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(limitRuns) as LadderRunStat[];
}

export interface LadderRow {
  rank: number;
  page: number;
  position: number;
  roomId: string | null;
  price: number | null;
  priceNightly: number | null;
}

export interface LatestLadder {
  runId: string;
  ts: string;
  total: number;
  currency: string | null;
  rows: LadderRow[];
}

// The most-recent full ladder for one search (area × stay × check-in). The basic
// building block the M2 curve-fitter reads.
export function latestLadder(profileId: string, nights: number, checkIn: string): LatestLadder | null {
  const db = getDb();
  const head = db
    .prepare(
      `SELECT run_id AS runId, MAX(ts) AS ts FROM search_results
        WHERE profile_id = ? AND nights = ? AND check_in = ?`,
    )
    .get(profileId, nights, checkIn) as { runId: string | null; ts: string | null } | undefined;
  if (!head?.runId) return null;
  const rows = db
    .prepare(
      `SELECT rank, page, position, room_id AS roomId, price, price_nightly AS priceNightly,
              total, currency
         FROM search_results
        WHERE profile_id = ? AND nights = ? AND check_in = ? AND run_id = ?
        ORDER BY rank`,
    )
    .all(profileId, nights, checkIn, head.runId) as Array<
    LadderRow & { total: number; currency: string | null }
  >;
  if (!rows.length) return null;
  return {
    runId: head.runId,
    ts: head.ts as string,
    total: rows[0].total,
    currency: rows[0].currency,
    rows: rows.map((r) => ({
      rank: r.rank,
      page: r.page,
      position: r.position,
      roomId: r.roomId,
      price: r.price,
      priceNightly: r.priceNightly,
    })),
  };
}
