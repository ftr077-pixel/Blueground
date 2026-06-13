// Per-suggestion scorecard — the closed loop at the granularity of a single
// applied suggestion. When a learned suggestion is applied (/api/learning/apply)
// we persist the model's prediction on the listing_price_changes row: the target
// page, the rank the listing should reach at the new price, and the confidence/n
// behind it. Here we score each one against what actually happened:
//
//   - rank outcome: did the listing reach the target page (or better) within the
//     evaluation window, per the scans captured AFTER the change?
//       · hit     — a post-change scan reached the target rank or better
//       · miss    — we saw post-change scans but none reached it, window elapsed
//       · pending — no qualifying scan yet, or window still open and not yet there
//   - booking outcome: did the mapped unit book within that window?
//
// The prediction is immutable (captured at apply time, since the model drifts);
// the outcome is DERIVED fresh from listing_snapshots + bookings on each read, so
// there is no separate evaluation job to run or stale verdict to maintain. Pure
// scoring lives up top; DB glue is at the bottom.

import { getDb } from "@/lib/db";
import { getListing } from "@/lib/repos/visibility";
import { WEB_PAGE_SIZE } from "./config";

const DAY = 86_400_000;
const pageOf = (rank: number) => Math.max(1, Math.ceil(rank / WEB_PAGE_SIZE));

export type RankOutcome = "hit" | "miss" | "pending";

export interface ScoredSuggestion {
  changeId: string;
  listingId: string;
  label: string;
  ts: string; // when the suggestion was applied
  oldNightly: number | null;
  newNightly: number | null;
  deltaPct: number | null;
  nights: number | null;
  targetPage: number;
  predictedRank: number; // rank we expected to reach at newNightly
  confidence: string | null;
  n: number | null;
  // Realized rank effect within the window.
  realizedRank: number | null; // best (lowest) rank reached post-change
  realizedPage: number | null;
  scans: number; // qualifying post-change scans observed in the window
  rankOutcome: RankOutcome;
  windowOpen: boolean; // eval window still open (later scans may still flip pending→hit)
  // Realized booking effect.
  unitMapped: boolean; // listing is linked to a unit (else we can't see bookings)
  booked: boolean; // a (non-cancelled) booking landed in the window
}

export interface Scorecard {
  windowDays: number;
  rows: ScoredSuggestion[];
  summary: {
    total: number; // applied suggestions with a prediction
    hits: number;
    misses: number;
    pending: number;
    decided: number; // hits + misses (rank outcome is definitive)
    hitRate: number | null; // hits / decided, 0..1
    unitMapped: number;
    bookedWithinWindow: number;
  };
}

interface ChangeRow {
  id: string;
  listingId: string;
  ts: string;
  oldNightly: number | null;
  newNightly: number | null;
  nights: number | null;
  targetPage: number;
  predictedRank: number;
  confidence: string | null;
  n: number | null;
}

// Score one persisted prediction against the post-change scans + bookings.
// `bestRank`/`scans` summarize the listing's found scans in the window; `booked`
// is whether a non-cancelled booking for the mapped unit landed in the window.
// Pure — the DB lookups happen in buildScorecard so this stays testable.
export function scoreSuggestion(
  c: ChangeRow,
  label: string,
  bestRank: number | null,
  scans: number,
  unitMapped: boolean,
  booked: boolean,
  windowDays: number,
  now: number = Date.now(),
): ScoredSuggestion {
  const windowOpen = now < Date.parse(c.ts) + windowDays * DAY;
  let rankOutcome: RankOutcome;
  if (bestRank != null && bestRank <= c.predictedRank) rankOutcome = "hit";
  else if (scans > 0 && !windowOpen) rankOutcome = "miss";
  else rankOutcome = "pending";

  const deltaPct =
    c.oldNightly != null && c.oldNightly > 0 && c.newNightly != null
      ? Math.round(((c.newNightly - c.oldNightly) / c.oldNightly) * 1000) / 10
      : null;

  return {
    changeId: c.id,
    listingId: c.listingId,
    label,
    ts: c.ts,
    oldNightly: c.oldNightly,
    newNightly: c.newNightly,
    deltaPct,
    nights: c.nights,
    targetPage: c.targetPage,
    predictedRank: c.predictedRank,
    confidence: c.confidence,
    n: c.n,
    realizedRank: bestRank,
    realizedPage: bestRank != null ? pageOf(bestRank) : null,
    scans,
    rankOutcome,
    windowOpen,
    unitMapped,
    booked,
  };
}

// ------------------------------------------------------------------ DB glue
export function buildScorecard(
  opts: { listingId?: string | null; windowDays?: number; limit?: number } = {},
): Scorecard {
  const db = getDb();
  const windowDays = opts.windowDays ?? 21;
  const limit = opts.limit ?? 50;

  const changes = db
    .prepare(
      `SELECT id, listing_id AS listingId, ts, old_nightly AS oldNightly,
              new_nightly AS newNightly, nights, target_page AS targetPage,
              predicted_rank AS predictedRank, confidence, n
         FROM listing_price_changes
        WHERE target_page IS NOT NULL AND predicted_rank IS NOT NULL
          ${opts.listingId ? "AND listing_id = @listingId" : ""}
        ORDER BY ts DESC
        LIMIT @limit`,
    )
    .all({ listingId: opts.listingId ?? null, limit }) as ChangeRow[];

  // Best (lowest) found rank for a listing in (changeTs, windowEnd], filtered to
  // the predicted stay length when we have one. This is the realized "did it
  // reach the page" signal — best over the window, so an early scan that hasn't
  // taken effect yet doesn't prematurely fail a prediction a later scan confirms.
  const rankAnyNights = db.prepare(
    `SELECT MIN(rank) AS bestRank, COUNT(*) AS scans
       FROM listing_snapshots
      WHERE listing_id = @listingId AND found = 1 AND rank IS NOT NULL
        AND ts > @from AND ts <= @to`,
  );
  const rankByNights = db.prepare(
    `SELECT MIN(rank) AS bestRank, COUNT(*) AS scans
       FROM listing_snapshots
      WHERE listing_id = @listingId AND found = 1 AND rank IS NOT NULL
        AND nights = @nights AND ts > @from AND ts <= @to`,
  );
  const bookingsInWindow = db.prepare(
    `SELECT COUNT(*) AS c
       FROM bookings
      WHERE unit_id = @unitId
        AND (status IS NULL OR status NOT IN ('CL','BL'))
        AND created_on IS NOT NULL
        AND created_on >= @fromDate AND created_on <= @toDate`,
  );

  const labelCache = new Map<string, { label: string; unitId: string | null }>();
  const listingInfo = (id: string) => {
    const hit = labelCache.get(id);
    if (hit) return hit;
    const l = getListing(id);
    const info = { label: l?.label ?? id, unitId: l?.unitId ?? null };
    labelCache.set(id, info);
    return info;
  };

  const rows: ScoredSuggestion[] = changes.map((c) => {
    const fromMs = Date.parse(c.ts);
    const toIso = new Date(fromMs + windowDays * DAY).toISOString();
    const rank = (
      c.nights != null
        ? rankByNights.get({ listingId: c.listingId, nights: c.nights, from: c.ts, to: toIso })
        : rankAnyNights.get({ listingId: c.listingId, from: c.ts, to: toIso })
    ) as { bestRank: number | null; scans: number };

    const { label, unitId } = listingInfo(c.listingId);
    let booked = false;
    if (unitId) {
      const b = bookingsInWindow.get({
        unitId,
        fromDate: c.ts.slice(0, 10),
        toDate: toIso.slice(0, 10),
      }) as { c: number };
      booked = b.c > 0;
    }

    return scoreSuggestion(
      c,
      label,
      rank.bestRank,
      rank.scans,
      unitId != null,
      booked,
      windowDays,
    );
  });

  const hits = rows.filter((r) => r.rankOutcome === "hit").length;
  const misses = rows.filter((r) => r.rankOutcome === "miss").length;
  const pending = rows.filter((r) => r.rankOutcome === "pending").length;
  const decided = hits + misses;
  return {
    windowDays,
    rows,
    summary: {
      total: rows.length,
      hits,
      misses,
      pending,
      decided,
      hitRate: decided > 0 ? Math.round((hits / decided) * 100) / 100 : null,
      unitMapped: rows.filter((r) => r.unitMapped).length,
      bookedWithinWindow: rows.filter((r) => r.booked).length,
    },
  };
}
