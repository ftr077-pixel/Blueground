// Strategy-success attribution — the M6 closed loop. Joins each realized
// booking (MiniHotel) back to what was live when it was booked:
//
//   - the ASKING price + search position from the last scan before the booking
//     (listing_snapshots, via the listing↔unit mapping), and
//   - the most recent deliberate price action before it (listing_price_changes),
//
// then scores strategies in aggregate: "bookings after a drop close at X% of
// asking, Y days after the move" and "of N drops, K were followed by a booking
// within the window". Pure selection/scoring here; DB glue at the bottom.

import { getDb } from "@/lib/db";
import { listListings } from "@/lib/repos/visibility";
import { listPriceChanges, type PriceChange } from "./dataset";

export interface SnapAtBooking {
  ts: string;
  nights: number;
  nightly: number | null;
  rank: number | null;
  page: number | null;
  found: boolean;
}

export type Strategy = "after-drop" | "after-raise" | "no-change";

export interface BookingAttribution {
  bookingId: string;
  listingId: string;
  unitId: string | null;
  createdOn: string;
  arrival: string | null;
  leadDays: number | null;
  realizedNightly: number | null;
  askingNightly: number | null;
  realizedPctOfAsking: number | null; // realized / asking × 100
  pageAtBooking: number | null;
  rankAtBooking: number | null;
  scanAgeDays: number | null; // booking date − scan ts
  strategy: Strategy;
  changeDeltaPct: number | null;
  daysFromChangeToBooking: number | null;
}

const DAY = 86_400_000;
const dayDiff = (laterIso: string, earlierIso: string) =>
  Math.round((Date.parse(laterIso) - Date.parse(earlierIso)) / DAY);
const round1 = (n: number) => Math.round(n * 10) / 10;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Attribute one booking. `snaps` = the listing's scan rows at/before the booking
// date (any order); `changes` = its logged price changes. Pure — testable on arrays.
export function attributeBooking(
  booking: {
    id: string;
    createdOn: string | null;
    arrival: string | null;
    leadDays: number | null;
    nights: number | null;
    nightly: number | null;
  },
  listingId: string,
  unitId: string | null,
  snaps: SnapAtBooking[],
  changes: Array<Pick<PriceChange, "ts" | "oldNightly" | "newNightly">>,
  changeWindowDays = 21,
): BookingAttribution | null {
  if (!booking.createdOn) return null; // no booking date → can't attribute timing
  const bookedAt = `${booking.createdOn}T23:59:59Z`;

  // Last scan at/before the booking; within that run prefer the same stay length.
  const eligible = snaps.filter((s) => s.ts <= bookedAt);
  eligible.sort(
    (a, b) =>
      b.ts.localeCompare(a.ts) ||
      Number(b.nights === booking.nights) - Number(a.nights === booking.nights),
  );
  const snap = eligible.find((s) => s.nightly != null) ?? eligible[0] ?? null;

  // Most recent deliberate price action before the booking, inside the window.
  const change =
    changes
      .filter(
        (c) =>
          c.ts <= bookedAt &&
          dayDiff(bookedAt, c.ts) <= changeWindowDays &&
          c.oldNightly != null &&
          c.newNightly != null,
      )
      .sort((a, b) => b.ts.localeCompare(a.ts))[0] ?? null;

  let strategy: Strategy = "no-change";
  let changeDeltaPct: number | null = null;
  let daysFromChangeToBooking: number | null = null;
  if (change && change.oldNightly && change.newNightly != null) {
    changeDeltaPct = round1(((change.newNightly - change.oldNightly) / change.oldNightly) * 100);
    strategy = change.newNightly < change.oldNightly ? "after-drop" : "after-raise";
    daysFromChangeToBooking = dayDiff(bookedAt, change.ts);
  }

  const asking = snap?.nightly ?? null;
  return {
    bookingId: booking.id,
    listingId,
    unitId,
    createdOn: booking.createdOn,
    arrival: booking.arrival,
    leadDays: booking.leadDays,
    realizedNightly: booking.nightly,
    askingNightly: asking != null ? Math.round(asking) : null,
    realizedPctOfAsking:
      booking.nightly != null && asking ? round1((booking.nightly / asking) * 100) : null,
    pageAtBooking: snap?.found ? snap.page : null,
    rankAtBooking: snap?.found ? snap.rank : null,
    scanAgeDays: snap ? dayDiff(bookedAt, snap.ts) : null,
    strategy,
    changeDeltaPct,
    daysFromChangeToBooking,
  };
}

export interface StrategySummary {
  strategy: Strategy;
  n: number;
  medianRealizedPctOfAsking: number | null;
  medianLeadDays: number | null;
  medianDaysFromChange: number | null;
}

export function summarizeStrategies(rows: BookingAttribution[]): StrategySummary[] {
  const order: Strategy[] = ["after-drop", "after-raise", "no-change"];
  return order
    .map((strategy) => {
      const g = rows.filter((r) => r.strategy === strategy);
      return {
        strategy,
        n: g.length,
        medianRealizedPctOfAsking: median(
          g.map((r) => r.realizedPctOfAsking).filter((v): v is number => v != null),
        ),
        medianLeadDays: median(g.map((r) => r.leadDays).filter((v): v is number => v != null)),
        medianDaysFromChange: median(
          g.map((r) => r.daysFromChangeToBooking).filter((v): v is number => v != null),
        ),
      };
    })
    .filter((s) => s.n > 0);
}

export interface FollowThrough {
  windowDays: number;
  drops: number;
  dropsBooked: number;
  raises: number;
  raisesBooked: number;
}

// Did a booking follow each logged change within the window? One listing's
// changes vs its unit's booking dates; the caller accumulates across listings.
export function changeFollowThrough(
  changes: Array<Pick<PriceChange, "ts" | "oldNightly" | "newNightly">>,
  bookingCreatedOn: string[],
  windowDays = 21,
): FollowThrough {
  const out: FollowThrough = { windowDays, drops: 0, dropsBooked: 0, raises: 0, raisesBooked: 0 };
  for (const c of changes) {
    if (c.oldNightly == null || c.newNightly == null) continue;
    const isDrop = c.newNightly < c.oldNightly;
    if (isDrop) out.drops++;
    else out.raises++;
    const booked = bookingCreatedOn.some((d) => {
      const delta = dayDiff(`${d}T12:00:00Z`, c.ts);
      return delta >= 0 && delta <= windowDays;
    });
    if (booked && isDrop) out.dropsBooked++;
    if (booked && !isDrop) out.raisesBooked++;
  }
  return out;
}

// ------------------------------------------------------------------ DB glue
export interface AttributionReport {
  attributions: BookingAttribution[];
  strategies: StrategySummary[];
  followThrough: FollowThrough;
  unattributed: number; // bookings without a listing↔unit link or booking date
}

interface BookingRow {
  id: string;
  unit_id: string | null;
  created_on: string | null;
  arrival: string | null;
  lead_days: number | null;
  nights: number | null;
  nightly: number | null;
}

interface SnapRow {
  ts: string;
  nights: number;
  found: number;
  price: number | null;
  rank: number | null;
  page: number | null;
}

export function buildAttributionReport(windowDays = 21): AttributionReport {
  const db = getDb();
  const bookings = db
    .prepare(
      `SELECT id, unit_id, created_on, arrival, lead_days, nights, nightly
         FROM bookings
        WHERE (status IS NULL OR status NOT IN ('CL','BL'))
        ORDER BY created_on DESC LIMIT 300`,
    )
    .all() as BookingRow[];

  // unit → first active tracked listing (the search-side identity of that unit).
  const byUnit = new Map<string, { id: string }>();
  for (const l of listListings()) {
    if (l.unitId && l.active && !byUnit.has(l.unitId)) byUnit.set(l.unitId, { id: l.id });
  }

  const snapStmt = db.prepare(
    `SELECT ts, nights, found, price, rank, page
       FROM listing_snapshots
      WHERE listing_id = ? AND ts <= ? AND price IS NOT NULL
      ORDER BY ts DESC LIMIT 24`,
  );

  const attributions: BookingAttribution[] = [];
  const followAcc: FollowThrough = { windowDays, drops: 0, dropsBooked: 0, raises: 0, raisesBooked: 0 };
  const bookingsByListing = new Map<string, string[]>();
  let unattributed = 0;

  for (const b of bookings) {
    const listing = b.unit_id ? byUnit.get(b.unit_id) : null;
    if (!listing || !b.created_on) {
      unattributed++;
      continue;
    }
    const snaps = (snapStmt.all(listing.id, `${b.created_on}T23:59:59Z`) as SnapRow[]).map(
      (s): SnapAtBooking => ({
        ts: s.ts,
        nights: s.nights,
        // Search cards carry the stay total; calendar rows carry nightly already.
        nightly: s.price == null ? null : s.found ? s.price / Math.max(1, s.nights) : s.price,
        rank: s.rank,
        page: s.page,
        found: !!s.found,
      }),
    );
    const changes = listPriceChanges(listing.id, 100);
    const row = attributeBooking(
      { id: b.id, createdOn: b.created_on, arrival: b.arrival, leadDays: b.lead_days, nights: b.nights, nightly: b.nightly },
      listing.id,
      b.unit_id,
      snaps,
      changes,
      windowDays,
    );
    if (row) {
      attributions.push(row);
      const arr = bookingsByListing.get(listing.id) ?? [];
      arr.push(b.created_on);
      bookingsByListing.set(listing.id, arr);
    } else {
      unattributed++;
    }
  }

  // Follow-through over every logged change of the listings seen above.
  for (const [listingId, dates] of bookingsByListing) {
    const ft = changeFollowThrough(listPriceChanges(listingId, 100), dates, windowDays);
    followAcc.drops += ft.drops;
    followAcc.dropsBooked += ft.dropsBooked;
    followAcc.raises += ft.raises;
    followAcc.raisesBooked += ft.raisesBooked;
  }

  return {
    attributions,
    strategies: summarizeStrategies(attributions),
    followThrough: followAcc,
    unattributed,
  };
}
