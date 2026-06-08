import { getDb } from "@/lib/db";
import { getListing, getProfile, type TrackedListing } from "@/lib/repos/visibility";
import { LEARNING, type LeadBucket } from "./config";
import type { Observation, SegmentKey } from "./types";

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Recency-weighted market ladder observations for a segment (area × stay length ×
// lead-time bucket) over the training window. Lead = check_in − scan ts.
export function marketObservations(
  seg: SegmentKey,
  bucket: LeadBucket,
): { obs: Observation[]; medianTotal: number; freshnessDays: number | null } {
  const db = getDb();
  const cutoff = new Date(Date.now() - LEARNING.windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT price_nightly AS priceNightly, rank, total, ts
         FROM search_results
        WHERE profile_id = @profileId AND nights = @nights
          AND ts >= @cutoff
          AND price_nightly IS NOT NULL AND price_nightly > 0
          AND total > 0
          AND (julianday(check_in) - julianday(ts)) >= @lmin
          AND (julianday(check_in) - julianday(ts)) <= @lmax
        ORDER BY ts DESC
        LIMIT @cap`,
    )
    .all({
      profileId: seg.profileId,
      nights: seg.nights,
      cutoff,
      lmin: bucket.min,
      lmax: bucket.max,
      cap: LEARNING.maxObs,
    }) as Array<{ priceNightly: number; rank: number; total: number; ts: string }>;

  const now = Date.now();
  const obs: Observation[] = [];
  const totals: number[] = [];
  let latest: number | null = null;
  for (const r of rows) {
    const tms = new Date(r.ts).getTime();
    const ageDays = (now - tms) / 86_400_000;
    const weight = Math.pow(0.5, ageDays / LEARNING.halfLifeDays);
    obs.push({ priceNightly: r.priceNightly, rank: r.rank, total: r.total, weight });
    totals.push(r.total);
    if (latest == null || tms > latest) latest = tms;
  }
  return {
    obs,
    medianTotal: median(totals),
    freshnessDays: latest == null ? null : (now - latest) / 86_400_000,
  };
}

export interface ListingState {
  listing: TrackedListing;
  area: string;
  nights: number;
  checkIn: string | null;
  currentNightly: number | null;
  currentRank: number | null;
  currentPage: number | null;
  total: number | null;
  found: boolean;
}

interface SnapRow {
  found: number;
  rank: number | null;
  page: number | null;
  total: number | null;
  price: number | null;
  check_in: string;
}

// Our listing's current point for a (stay length, check-in): asking nightly +
// where it currently ranks, from the latest scan. Picks the requested check-in,
// else the soonest dated window for that stay length.
export function listingState(
  listingId: string,
  nights: number,
  checkIn?: string | null,
): ListingState | null {
  const db = getDb();
  const listing = getListing(listingId);
  if (!listing) return null;
  const profile = getProfile(listing.profileId);
  const area = profile?.label ?? listing.profileId;

  const head = db
    .prepare("SELECT run_id FROM listing_snapshots WHERE listing_id = ? ORDER BY ts DESC LIMIT 1")
    .get(listingId) as { run_id: string } | undefined;

  let row: SnapRow | undefined;
  if (head) {
    if (checkIn) {
      row = db
        .prepare(
          `SELECT found, rank, page, total, price, check_in
             FROM listing_snapshots
            WHERE listing_id = ? AND run_id = ? AND nights = ? AND check_in = ? LIMIT 1`,
        )
        .get(listingId, head.run_id, nights, checkIn) as SnapRow | undefined;
    }
    if (!row) {
      row = db
        .prepare(
          `SELECT found, rank, page, total, price, check_in
             FROM listing_snapshots
            WHERE listing_id = ? AND run_id = ? AND nights = ? AND check_in <> ''
            ORDER BY found DESC, check_in ASC LIMIT 1`,
        )
        .get(listingId, head.run_id, nights) as SnapRow | undefined;
    }
  }

  if (!row) {
    return {
      listing,
      area,
      nights,
      checkIn: checkIn ?? null,
      currentNightly: null,
      currentRank: null,
      currentPage: null,
      total: null,
      found: false,
    };
  }

  const found = !!row.found;
  // Search cards carry the stay total; a not-found snapshot carries the calendar
  // nightly rate. Normalize both to nightly (mirrors snapStayPrice in revenue.ts).
  const currentNightly =
    row.price == null ? null : found && nights > 0 ? row.price / nights : row.price;

  return {
    listing,
    area,
    nights,
    checkIn: row.check_in || checkIn || null,
    currentNightly,
    currentRank: found ? row.rank : null,
    currentPage: found ? row.page : null,
    total: row.total,
    found,
  };
}
