import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { LADDER_RETENTION } from "@/lib/learning/config";

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

// ---------------------------------------------------------------- retention
function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Design §4.3: raw ladder rows older than rawDays are downsampled into
// search_ladder_summary (nightly-price percentiles per search × rank decile),
// then deleted. Guarded to run at most once per pruneEveryHours (recordRun calls
// it after every ingest). Nothing in the learner reads beyond its 21d window, so
// pruning never affects recommendations — only long-horizon storage.
export function pruneLadder(opts: { force?: boolean; now?: number } = {}): {
  summarized: number;
  deleted: number;
} | null {
  const db = getDb();
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const last = db
      .prepare("SELECT value FROM meta WHERE key = 'ladder_pruned_at'")
      .get() as { value: string } | undefined;
    if (last) {
      const age = now - new Date(last.value).getTime();
      if (Number.isFinite(age) && age < LADDER_RETENTION.pruneEveryHours * 3_600_000) return null;
    }
  }
  const cutoff = new Date(now - LADDER_RETENTION.rawDays * 86_400_000).toISOString();

  const old = db
    .prepare(
      `SELECT profile_id, nights, check_in, run_id, ts, rank, total, price_nightly, currency
         FROM search_results WHERE ts < ?`,
    )
    .all(cutoff) as Array<{
    profile_id: string;
    nights: number;
    check_in: string;
    run_id: string;
    ts: string;
    rank: number;
    total: number;
    price_nightly: number | null;
    currency: string | null;
  }>;

  // Group by search × rank decile (1..10 of rank/total).
  const groups = new Map<
    string,
    { head: (typeof old)[number]; decile: number; nightly: number[] }
  >();
  for (const r of old) {
    if (r.price_nightly == null || r.total <= 0) continue;
    const decile = Math.min(10, Math.max(1, Math.ceil((r.rank / r.total) * 10)));
    const key = `${r.run_id}|${r.check_in}|${r.nights}|${decile}`;
    const g = groups.get(key) ?? { head: r, decile, nightly: [] };
    g.nightly.push(r.price_nightly);
    groups.set(key, g);
  }

  const ins = db.prepare(
    `INSERT OR REPLACE INTO search_ladder_summary
       (profile_id, nights, check_in, run_id, ts, decile, n, p10, p25, p50, p75, p90, currency)
     VALUES (@profile_id, @nights, @check_in, @run_id, @ts, @decile, @n, @p10, @p25, @p50, @p75, @p90, @currency)`,
  );
  let summarized = 0;
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const g of groups.values()) {
      const s = [...g.nightly].sort((a, b) => a - b);
      ins.run({
        profile_id: g.head.profile_id,
        nights: g.head.nights,
        check_in: g.head.check_in,
        run_id: g.head.run_id,
        ts: g.head.ts,
        decile: g.decile,
        n: s.length,
        p10: percentile(s, 0.1),
        p25: percentile(s, 0.25),
        p50: percentile(s, 0.5),
        p75: percentile(s, 0.75),
        p90: percentile(s, 0.9),
        currency: g.head.currency,
      });
      summarized++;
    }
    deleted = db.prepare("DELETE FROM search_results WHERE ts < ?").run(cutoff).changes;
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('ladder_pruned_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(new Date(now).toISOString());
  });
  tx();
  return { summarized, deleted };
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
