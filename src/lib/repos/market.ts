import { getDb } from "@/lib/db";

// Shapes mirror the AirROI Markets API (api.airroi.com, OpenAPI v2.1.1).
export interface AirRoiMarket {
  full_name?: string;
  country: string;
  region: string;
  locality: string;
  district: string;
}

export interface MarketSummary {
  occupancy: number;
  average_daily_rate: number;
  rev_par: number;
  revenue: number;
  booking_lead_time: number;
  length_of_stay: number;
  min_nights: number;
  active_listings_count: number;
}

export interface PacingPoint {
  date: string; // yyyy-MM-dd
  booked_count: number;
  available_count: number;
  booked_rate_avg: number;
  available_rate_avg: number;
  fill_rate: number; // 0..1 forward occupancy
}

export interface MinNightsPoint {
  date: string;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

// Monthly historical series — one call to /markets/metrics/all.
export interface MetricsPoint {
  date: string;
  occupancy: number;
  average_daily_rate: number;
  revpar: number;
  revenue: number;
  booking_lead_time: number;
  length_of_stay: number;
  min_nights: number;
  active_listings_count: number;
}

// Extra PriceLabs report datasets that don't fit the core snapshot columns.
export interface BookingCurveMonth {
  month: string;
  /** pickup points: w = days before arrival, o = occupancy %, ly = last-year occupancy %. */
  points: { w: number; o: number; ly: number }[];
}
export interface LosBucket {
  bucket: string;
  count: number;
  share: number; // % of bookings
  bnp: number; // avg booked nightly price
}
export interface SummaryTableRow {
  category: string;
  occupancy: number; // %
  adr: number;
  revpar: number;
  los: number;
  bookingWindow: number;
}
export interface MarketExtras {
  bookingCurves?: BookingCurveMonth[];
  los?: LosBucket[];
  summaryTable?: { kind: string; rows: SummaryTableRow[] };
}

export interface MarketSnapshot {
  neighborhood: string;
  marketName: string | null;
  fetchedAt: string;
  currency: string | null;
  summary: MarketSummary | null;
  pacing: PacingPoint[];
  minNights: MinNightsPoint[];
  metrics: MetricsPoint[];
  /** Human label of the comp filter applied (e.g. "2 BR"), or null for all units. */
  filterLabel: string | null;
  /** Provider that wrote the row: "airroi" | "pricelabs". Legacy rows = "airroi". */
  source: string;
  /** Extra report datasets (PriceLabs booking curves / LOS / per-bedroom table), or null. */
  extras: MarketExtras | null;
}

interface MarketSnapshotSql {
  neighborhood: string;
  market_name: string | null;
  fetched_at: string;
  currency: string | null;
  summary: string | null;
  pacing: string | null;
  min_nights: string | null;
  metrics: string | null;
  filter: string | null;
  source: string | null;
  extras: string | null;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSnapshot(r: MarketSnapshotSql): MarketSnapshot {
  return {
    neighborhood: r.neighborhood,
    marketName: r.market_name,
    fetchedAt: r.fetched_at,
    currency: r.currency,
    summary: parse<MarketSummary | null>(r.summary, null),
    pacing: parse<PacingPoint[]>(r.pacing, []),
    minNights: parse<MinNightsPoint[]>(r.min_nights, []),
    metrics: parse<MetricsPoint[]>(r.metrics, []),
    filterLabel: r.filter,
    source: r.source ?? "airroi",
    extras: parse<MarketExtras | null>(r.extras, null),
  };
}

export interface MarketSnapshotInput {
  neighborhood: string;
  marketName: string | null;
  currency: string;
  summary: MarketSummary | null;
  pacing: PacingPoint[];
  minNights: MinNightsPoint[];
  metrics: MetricsPoint[];
  filterLabel: string | null;
  /** "airroi" (default) | "pricelabs". */
  source?: string;
  extras?: MarketExtras | null;
}

export function upsertMarketSnapshot(input: MarketSnapshotInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO market_snapshots (neighborhood, market_name, fetched_at, currency, summary, pacing, min_nights, metrics, filter, source, extras)
     VALUES (@neighborhood, @market_name, @fetched_at, @currency, @summary, @pacing, @min_nights, @metrics, @filter, @source, @extras)
     ON CONFLICT(neighborhood) DO UPDATE SET
       market_name = excluded.market_name,
       fetched_at  = excluded.fetched_at,
       currency    = excluded.currency,
       summary     = excluded.summary,
       pacing      = excluded.pacing,
       min_nights  = excluded.min_nights,
       metrics     = excluded.metrics,
       filter      = excluded.filter,
       source      = excluded.source,
       extras      = excluded.extras`,
  ).run({
    neighborhood: input.neighborhood,
    market_name: input.marketName,
    fetched_at: new Date().toISOString(),
    currency: input.currency,
    summary: input.summary ? JSON.stringify(input.summary) : null,
    pacing: JSON.stringify(input.pacing ?? []),
    min_nights: JSON.stringify(input.minNights ?? []),
    metrics: JSON.stringify(input.metrics ?? []),
    filter: input.filterLabel ?? null,
    source: input.source ?? "airroi",
    extras: input.extras ? JSON.stringify(input.extras) : null,
  });
}

// The market source the app currently treats as truth ("airroi" | "pricelabs").
// Stored as a setting so an ingest can flip it; defaults to "airroi" so existing
// (legacy, source-less) rows keep showing until PriceLabs data is imported.
export function activeMarketSource(): string {
  const db = getDb();
  const r = db.prepare("SELECT value FROM meta WHERE key = 'setting:market_source'").get() as
    | { value: string }
    | undefined;
  return r?.value ?? "airroi";
}

export function getMarketSnapshot(neighborhood: string): MarketSnapshot | null {
  const db = getDb();
  const r = db
    .prepare("SELECT * FROM market_snapshots WHERE neighborhood = ?")
    .get(neighborhood) as MarketSnapshotSql | undefined;
  return r ? rowToSnapshot(r) : null;
}

// Snapshots for the active market source (or an explicit one). Every reader —
// the dashboard, the pricing engine providers, base-price + pacing — goes through
// here, so flipping `setting:market_source` switches the whole app's source of
// truth. Legacy rows with a NULL source count as "airroi".
export function listMarketSnapshots(source?: string): MarketSnapshot[] {
  const db = getDb();
  const want = source ?? activeMarketSource();
  return (
    db
      .prepare(
        "SELECT * FROM market_snapshots WHERE COALESCE(source, 'airroi') = ? ORDER BY neighborhood",
      )
      .all(want) as MarketSnapshotSql[]
  ).map(rowToSnapshot);
}
