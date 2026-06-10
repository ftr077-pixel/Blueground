import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { ACTIVITY_FEED, DEPARTMENTS } from "@/lib/mock-data";
import { APPROVAL_QUEUE } from "@/lib/action-center-data";
import { UNIT_PRICING_DEFAULTS, PRICING_AGENT } from "@/lib/config/pricing";
import { randomUUID } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "orchestrator.db");

declare global {
  // eslint-disable-next-line no-var
  var __rohubDb: Database.Database | undefined;
}

function ensureColumn(db: Database.Database, table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function init(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_items (
      id            TEXT PRIMARY KEY,
      department    TEXT NOT NULL,
      worker        TEXT NOT NULL,
      proposed_action TEXT NOT NULL,
      rationale     TEXT NOT NULL,
      blast_radius  TEXT NOT NULL,
      amount        TEXT,
      raised_at     TEXT NOT NULL,
      rule          TEXT NOT NULL,
      payload       TEXT
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id            TEXT PRIMARY KEY,
      item_id       TEXT NOT NULL REFERENCES approval_items(id),
      outcome       TEXT NOT NULL CHECK (outcome IN ('approved','rejected')),
      decided_at    TEXT NOT NULL,
      decided_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id            TEXT PRIMARY KEY,
      ts            TEXT NOT NULL,
      department    TEXT NOT NULL,
      worker        TEXT NOT NULL,
      message       TEXT NOT NULL,
      level         TEXT NOT NULL CHECK (level IN ('info','success','warning','danger'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_events(ts DESC);

    CREATE TABLE IF NOT EXISTS units (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      neighborhood    TEXT NOT NULL,
      bedrooms        INTEGER NOT NULL,
      base_rate       INTEGER NOT NULL,
      current_rate    INTEGER NOT NULL,
      occupancy_30d   REAL NOT NULL,
      platform        TEXT NOT NULL,
      last_rate_change_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pricing_history (
      id            TEXT PRIMARY KEY,
      unit_id       TEXT NOT NULL REFERENCES units(id),
      ts            TEXT NOT NULL,
      old_rate      INTEGER NOT NULL,
      new_rate      INTEGER NOT NULL,
      delta_pct     REAL NOT NULL,
      reason        TEXT NOT NULL,
      signals       TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('applied','pending_approval','rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_unit_ts ON pricing_history(unit_id, ts DESC);

    CREATE TABLE IF NOT EXISTS tracked_searches (
      id            TEXT PRIMARY KEY,
      listing_id    TEXT NOT NULL,
      label         TEXT NOT NULL,
      platform      TEXT NOT NULL DEFAULT 'Airbnb',
      unit_id       TEXT,
      guests        INTEGER NOT NULL DEFAULT 2,
      currency      TEXT NOT NULL DEFAULT 'ILS',
      sw_lat        REAL NOT NULL,
      sw_lng        REAL NOT NULL,
      ne_lat        REAL NOT NULL,
      ne_lng        REAL NOT NULL,
      zoom          INTEGER NOT NULL DEFAULT 14,
      stay_nights   TEXT NOT NULL,
      start_dates   TEXT NOT NULL,
      min_nights    INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      last_run_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS rank_snapshots (
      id            TEXT PRIMARY KEY,
      search_id     TEXT NOT NULL REFERENCES tracked_searches(id),
      listing_id    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      ts            TEXT NOT NULL,
      stay_label    TEXT NOT NULL,
      nights        INTEGER NOT NULL,
      check_in      TEXT NOT NULL,
      check_out     TEXT NOT NULL,
      eligible      INTEGER NOT NULL,
      min_nights    INTEGER,
      found         INTEGER NOT NULL,
      page          INTEGER,
      position      INTEGER,
      rank          INTEGER,
      total         INTEGER,
      price         REAL,
      currency      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_search_ts ON rank_snapshots(search_id, ts DESC);

    CREATE TABLE IF NOT EXISTS search_profiles (
      id            TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      platform      TEXT NOT NULL DEFAULT 'Airbnb',
      guests        INTEGER NOT NULL DEFAULT 2,
      currency      TEXT NOT NULL DEFAULT 'ILS',
      sw_lat        REAL NOT NULL,
      sw_lng        REAL NOT NULL,
      ne_lat        REAL NOT NULL,
      ne_lng        REAL NOT NULL,
      zoom          INTEGER NOT NULL DEFAULT 14,
      stay_nights   TEXT NOT NULL,
      start_dates   TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      last_run_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS tracked_listings (
      id            TEXT PRIMARY KEY,
      airbnb_id     TEXT NOT NULL,
      label         TEXT NOT NULL,
      platform      TEXT NOT NULL DEFAULT 'Airbnb',
      profile_id    TEXT NOT NULL REFERENCES search_profiles(id),
      unit_id       TEXT,
      guests        INTEGER,
      start_dates   TEXT,
      min_nights    INTEGER,
      min_nights_checked_at TEXT,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_profile ON tracked_listings(profile_id);

    CREATE TABLE IF NOT EXISTS listing_snapshots (
      id            TEXT PRIMARY KEY,
      listing_id    TEXT NOT NULL REFERENCES tracked_listings(id),
      airbnb_id     TEXT NOT NULL,
      profile_id    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      ts            TEXT NOT NULL,
      stay_label    TEXT NOT NULL,
      nights        INTEGER NOT NULL,
      check_in      TEXT NOT NULL,
      check_out     TEXT NOT NULL,
      eligible      INTEGER NOT NULL,
      min_nights    INTEGER,
      found         INTEGER NOT NULL,
      page          INTEGER,
      position      INTEGER,
      rank          INTEGER,
      total         INTEGER,
      price         REAL,
      currency      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lsnap_listing_ts ON listing_snapshots(listing_id, ts DESC);

    -- Full competitor price ladder per search (every result's price at its
    -- position), captured from the same result set the scraper already fetches.
    -- One row per (search, rank); a "search" = profile × run × check-in × nights
    -- × guests. This is the substrate for the price→position learner: a single
    -- scan yields the whole market price-vs-rank curve for that exact query.
    CREATE TABLE IF NOT EXISTS search_results (
      id            TEXT PRIMARY KEY,
      profile_id    TEXT NOT NULL REFERENCES search_profiles(id),
      run_id        TEXT NOT NULL,
      ts            TEXT NOT NULL,
      check_in      TEXT NOT NULL,
      check_out     TEXT NOT NULL,
      nights        INTEGER NOT NULL,
      guests        INTEGER NOT NULL,
      total         INTEGER NOT NULL,
      room_id       TEXT,
      rank          INTEGER NOT NULL,
      page          INTEGER NOT NULL,
      position      INTEGER NOT NULL,
      price         REAL,
      price_nightly REAL,
      currency      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_results_segment ON search_results(profile_id, nights, check_in, run_id);
    CREATE INDEX IF NOT EXISTS idx_results_ts ON search_results(ts);

    -- Log of deliberate per-listing price changes (operator/agent), so the
    -- longitudinal learner (Model B) can attribute rank moves to our own moves.
    -- Observed price drift is read directly from listing_snapshots; this table is
    -- the rails for intentional changes + the experiment loop.
    CREATE TABLE IF NOT EXISTS listing_price_changes (
      id          TEXT PRIMARY KEY,
      listing_id  TEXT NOT NULL REFERENCES tracked_listings(id),
      ts          TEXT NOT NULL,
      old_nightly REAL,
      new_nightly REAL,
      source      TEXT NOT NULL,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lpc_listing_ts ON listing_price_changes(listing_id, ts DESC);

    -- Realized booking outcomes pulled from MiniHotel (Content & Data API,
    -- GetReservationKey). The ground truth the learner ultimately optimizes for:
    -- what actually booked, when it was booked (lead time = arrival − created_on),
    -- and at what realized price. id = MiniHotel reservation id (idempotent upsert).
    CREATE TABLE IF NOT EXISTS bookings (
      id            TEXT PRIMARY KEY,
      portal_res_id TEXT,
      unit_id       TEXT,
      room_type     TEXT,
      source        TEXT,
      status        TEXT,
      created_on    TEXT,
      arrival       TEXT,
      departure     TEXT,
      nights        INTEGER,
      guests        INTEGER,
      total         REAL,
      nightly       REAL,
      currency      TEXT,
      lead_days     INTEGER,
      synced_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_unit ON bookings(unit_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_arrival ON bookings(arrival);

    -- The market's booking pace (lead-time distribution) per area × stay length,
    -- supplied by the operator. The benchmark we compare our own pace against
    -- ("are we behind/ahead of how the market books?"). lead_cdf is JSON:
    -- [{ leadDays, bookedPct }].
    CREATE TABLE IF NOT EXISTS market_pace (
      profile_id       TEXT NOT NULL,
      nights           INTEGER NOT NULL,
      median_lead_days REAL,
      lead_cdf         TEXT,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (profile_id, nights)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL
    );

    -- Operator-entered P&L lines (operating costs, extra revenue streams) that
    -- aren't derivable from units/listings. Revenue and direct costs are
    -- computed live; these are the manual additions on top.
    CREATE TABLE IF NOT EXISTS pnl_lines (
      id             TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      category       TEXT NOT NULL CHECK (category IN ('revenue','cost')),
      section        TEXT NOT NULL DEFAULT 'Operating',
      monthly_amount REAL NOT NULL DEFAULT 0,
      growth_pct     REAL NOT NULL DEFAULT 0,
      active         INTEGER NOT NULL DEFAULT 1,
      sort           INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );

    -- Per-listing, per-night rate overrides. The Rates Calendar computes a
    -- deterministic baseline (rate + occupancy) on read; this table stores only
    -- *overrides*: operator edits (source='manual') and ingested actuals from
    -- MiniHotel Bulk ARI (source='minihotel'). NULL columns mean "not overridden".
    CREATE TABLE IF NOT EXISTS rate_calendar (
      unit_id     TEXT NOT NULL REFERENCES units(id),
      date        TEXT NOT NULL,
      price       INTEGER,
      available   INTEGER,
      min_nights  INTEGER,
      closed      INTEGER,
      booked      INTEGER,
      source      TEXT NOT NULL DEFAULT 'manual',
      updated_at  TEXT,
      PRIMARY KEY (unit_id, date)
    );

    -- Actual reservations pulled from MiniHotel (Content & Data API). This is the
    -- source of *real* revenue actuals: room revenue per booking, recognized per
    -- night across the stay (see repos/reservations). Cancelled / no-show rows and
    -- test apartments are kept but excluded from revenue. The revenue column is NET
    -- of VAT (Israeli guests pay 18%, tourists are zero-rated); gross/vat keep the
    -- breakdown for audit. unit_id is the mapped Hub unit (nullable).
    CREATE TABLE IF NOT EXISTS reservation (
      id          TEXT PRIMARY KEY,
      unit_id     TEXT,
      room_type   TEXT,
      room_number TEXT,
      check_in    TEXT NOT NULL,
      check_out   TEXT NOT NULL,
      nights      INTEGER NOT NULL,
      revenue     INTEGER NOT NULL,
      gross       INTEGER,
      vat         INTEGER,
      vat_basis   TEXT,
      currency    TEXT,
      country     TEXT,
      status      TEXT,
      source      TEXT NOT NULL DEFAULT 'minihotel',
      updated_at  TEXT
    );

    -- Occupancy backbone from MiniHotel's ARI server (Room Status Inquiry). These
    -- bookings carry no revenue (that's the Content & Data API), but they're the
    -- real occupancy: which room is booked which nights. Refreshed as a full
    -- snapshot each sync. ari_room is the room inventory (the occupancy denominator).
    CREATE TABLE IF NOT EXISTS ari_booking (
      res_number  TEXT PRIMARY KEY,
      room_number TEXT,
      room_type   TEXT,
      check_in    TEXT NOT NULL,
      check_out   TEXT NOT NULL,
      status      TEXT,
      updated_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS ari_room (
      room_number TEXT PRIMARY KEY,
      room_type   TEXT
    );
  `);

  // Reservation columns added after the table first shipped.
  ensureColumn(db, "reservation", "room_number", "TEXT");
  ensureColumn(db, "reservation", "gross", "INTEGER");
  ensureColumn(db, "reservation", "vat", "INTEGER");
  ensureColumn(db, "reservation", "vat_basis", "TEXT");
  ensureColumn(db, "reservation", "country", "TEXT");

  // Migrations for DBs created before these columns existed.
  ensureColumn(db, "tracked_listings", "guests", "INTEGER");
  ensureColumn(db, "tracked_listings", "start_dates", "TEXT");
  ensureColumn(db, "listing_snapshots", "available", "INTEGER");
  ensureColumn(db, "search_profiles", "date_mode", "TEXT");
  ensureColumn(db, "tracked_listings", "monthly_rent", "REAL");
  ensureColumn(db, "tracked_listings", "utilities", "REAL");
  ensureColumn(db, "tracked_listings", "cleaning_fee", "REAL");
  ensureColumn(db, "tracked_listings", "address", "TEXT");

  // One-time backfill: give every apartment the default utilities/cleaning the
  // operator asked for, so the costs are filled in and visible (not just applied
  // implicitly in the profit math). Runs once, guarded by a meta flag.
  const costsBackfilled = db
    .prepare("SELECT value FROM meta WHERE key = 'cost_defaults_backfilled'")
    .get();
  if (!costsBackfilled) {
    db.exec(`
      UPDATE tracked_listings SET utilities = 1000 WHERE utilities IS NULL;
      UPDATE tracked_listings SET cleaning_fee = 500 WHERE cleaning_fee IS NULL;
    `);
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('cost_defaults_backfilled', 'v1')",
    ).run();
  }

  // Pricing v2 (PriceLabs-inspired): per-unit price floor/ceiling, weekly/monthly
  // LOS discounts, and a minimum-stay policy (recommended + hard floor).
  // Defaults come from src/lib/config/pricing.ts (single source of truth).
  ensureColumn(db, "units", "min_rate", "INTEGER");
  ensureColumn(db, "units", "max_rate", "INTEGER");
  ensureColumn(db, "units", "weekly_discount_pct", `REAL NOT NULL DEFAULT ${UNIT_PRICING_DEFAULTS.weeklyDiscountPct}`);
  ensureColumn(db, "units", "monthly_discount_pct", `REAL NOT NULL DEFAULT ${UNIT_PRICING_DEFAULTS.monthlyDiscountPct}`);
  ensureColumn(db, "units", "min_stay", `INTEGER NOT NULL DEFAULT ${UNIT_PRICING_DEFAULTS.minStay}`);
  ensureColumn(db, "units", "lowest_min_stay", `INTEGER NOT NULL DEFAULT ${UNIT_PRICING_DEFAULTS.lowestMinStay}`);

  // MiniHotel connection: each unit maps to a MiniHotel room-type code (names
  // differ between this app and MiniHotel, so we store the link explicitly).
  ensureColumn(db, "units", "minihotel_room_type", "TEXT");
  // Floors/ceilings derive from the base rate; backfill any rows still missing
  // them (covers both pre-existing DBs and freshly-seeded rows, which insert
  // only the original columns), ₪-step rounded.
  const floorPct = UNIT_PRICING_DEFAULTS.floorPctOfBase;
  const ceilPct = UNIT_PRICING_DEFAULTS.ceilingPctOfBase;
  const step = PRICING_AGENT.roundingStep;
  db.exec(`
    UPDATE units SET min_rate = CAST(ROUND(base_rate * ${floorPct} / ${step}) * ${step} AS INTEGER) WHERE min_rate IS NULL;
    UPDATE units SET max_rate = CAST(ROUND(base_rate * ${ceilPct} / ${step}) * ${step} AS INTEGER) WHERE max_rate IS NULL;
  `);

  // Cached market data from the external provider (AirROI). One row per
  // neighborhood; refreshed by the daily market sync. JSON blobs hold the raw
  // metric payloads so the providers/Market view can read without re-fetching
  // (the API is pay-per-call).
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      neighborhood  TEXT PRIMARY KEY,
      market_name   TEXT,
      fetched_at    TEXT NOT NULL,
      currency      TEXT,
      summary       TEXT,
      pacing        TEXT,
      min_nights    TEXT,
      metrics       TEXT,
      filter        TEXT
    );
  `);
  ensureColumn(db, "market_snapshots", "metrics", "TEXT");
  ensureColumn(db, "market_snapshots", "filter", "TEXT");
}

function seed(db: Database.Database) {
  const seeded = db
    .prepare("SELECT value FROM meta WHERE key = 'seeded'")
    .get() as { value: string } | undefined;
  if (seeded?.value === "v1") return;

  const insertItem = db.prepare(`
    INSERT INTO approval_items (id, department, worker, proposed_action, rationale, blast_radius, amount, raised_at, rule, payload)
    VALUES (@id, @department, @worker, @proposed_action, @rationale, @blast_radius, @amount, @raised_at, @rule, @payload)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO activity_events (id, ts, department, worker, message, level)
    VALUES (@id, @ts, @department, @worker, @message, @level)
  `);
  const insertUnit = db.prepare(`
    INSERT INTO units (id, name, neighborhood, bedrooms, base_rate, current_rate, occupancy_30d, platform)
    VALUES (@id, @name, @neighborhood, @bedrooms, @base_rate, @current_rate, @occupancy_30d, @platform)
  `);

  const tx = db.transaction(() => {
    for (const a of APPROVAL_QUEUE) {
      insertItem.run({
        id: a.id,
        department: a.department,
        worker: a.worker,
        proposed_action: a.proposedAction,
        rationale: a.rationale,
        blast_radius: a.blastRadius,
        amount: a.amount ?? null,
        raised_at: a.raisedAt,
        rule: a.rule,
        payload: null,
      });
    }
    for (const e of ACTIVITY_FEED) {
      insertEvent.run({
        id: e.id,
        ts: e.ts,
        department: e.department,
        worker: e.worker,
        message: e.message,
        level: e.level,
      });
    }
    for (const u of SEED_UNITS) {
      insertUnit.run(u);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', 'v1')").run();
  });
  tx();
  // suppress unused import warning if departments aren't directly read
  void DEPARTMENTS;
}

// The live Tel-Aviv portfolio. Addresses are the names as they arrive from
// MiniHotel; the operator identifies each apartment by its internal ID — the
// number rendered first in the Rates Calendar. IDs are intentionally sparse
// (some numbers retired), so we key off the explicit id, not array position.
const APARTMENTS: Array<[number, string]> = [
  [1, "Florentin 7, 23"],
  [2, "Herzl 114, 32"],
  [3, "Herzl 114, 2"],
  [4, "Herzl 114, 14"],
  [5, "Herzl 114, 3"],
  [6, "Rambam 24, 7"],
  [7, "Rambam 24, 10"],
  [8, "Rambam 24, 11"],
  [9, "Rambam 24, 12"],
  [10, "Rambam 24, 16"],
  [11, "Rambam 24, 15"],
  [12, "Markolet 5, 3"],
  [13, "Halutzim 28, 1"],
  [14, "Halutzim 28, 2"],
  [15, "Halutzim 28, 3"],
  [16, "Halutzim 28, 4"],
  [17, "Halutzim 28, 5"],
  [18, "Halutzim 28, 6"],
  [19, "Halutzim 28, 7"],
  [20, "Halutzim 28, 8"],
  [21, "Halutzim 28, 9"],
  [22, "Trumpeldor 20, 6"],
  [23, "Levontin 26, 23"],
  [24, "Markolet 5, 4"],
  [25, "Markolet 5, 10"],
  [26, "Markolet 5, 14"],
  [27, "Rambam 24, 17"],
  [28, "Rambam 24, 19"],
  [29, "Harugei Malchut 10, 5"],
  [30, "Mohaliver Street 31, 2"],
  [31, "Mohaliver Street 31, 4"],
  [32, "Mohaliver Street 31, 11"],
  [33, "Mohaliver Street 31, 12"],
  [34, "Mohaliver Street 31, 13"],
  [35, "Mohaliver Street 31, 15"],
  [36, "Mohaliver Street 31, 16"],
  [37, "Mohaliver Street 31, 17"],
  [38, "Trumpeldor 20, 7"],
  [39, "Dizengoff 282, 4"],
  [40, "Meitav 5, 140"],
  [41, "Menachem Begin 158, 166"],
  [42, "Dizengoff 288, 3"],
  [43, "Dizengoff 288, 10"],
  [44, "Markolet 5, 8"],
  [45, "Rambam 24, 1"],
  [46, "Levontin 26, 3"],
  [47, "Rambam 24, 18"],
  [48, "Herzl 4, 9"],
  [49, "Dizengoff 288, 9"],
  [50, "Mohaliver Street 31, 9"],
  [51, "Nahalat Binyamin 9, 3"],
  [52, "Nahalat Binyamin 9, 4"],
  [53, "Nahalat Binyamin 9, 5"],
  [54, "Nahalat Binyamin 9, 6"],
  [55, "Nahalat Binyamin 9, 7"],
  [56, "Nahalat Binyamin 9, 8"],
  [57, "Nahalat Binyamin 9, 9"],
  [58, "Nahalat Binyamin 9, 10"],
  [59, "Menachem Begin 160, 148"],
  [60, "Wyssotsky 6, 24"],
  [61, "Wyssotsky 6, 25"],
  [63, "Rambam 24, 9"],
  [64, "Shlomo Ibn Gabirol Street 144, 20"],
  [65, "Derech Menachem Begin 160, 149"],
  [66, "Jerusalem Boulevard 1, 17"],
  [67, "Wyssotsky 8, 74"],
  [68, "Shlomo Ibn Gabirol Street 144, 16"],
  [70, "HaYarkon Street 276, #2"],
  [71, "HaYarkon Street 276, #3"],
  [72, "HaYarkon Street 276, #4"],
  [73, "HaYarkon Street 276, #5"],
  [74, "HaYarkon Street 276, #6"],
  [75, "HaYarkon Street 276, #7"],
  [76, "Florentin 7, 22"],
  [77, "Shlomo Ibn Gabirol Street 144, 24"],
  [78, "Rambam 24, 2"],
  [79, "Nitzana 9"],
  [80, "Arlozorov 33, 4A"],
  [81, "Arlozorov 33, 4B"],
  [82, "Rembrandt 20, 10"],
  [83, "Shlomo Ibn Gabirol Street 144, 6"],
  [84, "Melchett 52, 3"],
  [85, "Allenby 114, 3"],
  [86, "Allenby 114, 4"],
  [87, "Allenby 114, 5"],
  [88, "Allenby 114, 6"],
  [89, "Allenby 114, 7"],
  [90, "Allenby 114, 8"],
  [91, "Allenby 114, 9"],
  [92, "Allenby 114, 10"],
  [93, "Allenby 114, 11"],
  [94, "Allenby 114, 12"],
  [95, "Allenby 114, 13"],
  [96, "Allenby 114, 14"],
  [97, "Allenby 114, 15"],
  [98, "Allenby 114, 16"],
  [99, "Allenby 114, 17"],
  [100, "Yavnieli 24, 15"],
  [101, "Trumpeldor 20, 5"],
  [102, "Rambam 24, 3"],
  [103, "Trumpeldor 20, 4"],
  [105, "Rambam 24, 14"],
  [112, "Yitzhak Elhanan 14, 14"],
  [113, "HaYarkon 276, 9"],
  [114, "Levontin 26, 2"],
  [115, "Totzeret HaAretz 5 apt 289"],
];

// Neighborhood grouping = the street (everything before the building number).
function streetOf(addr: string): string {
  const m = addr.match(/^(.*?)[\s,]*\d/);
  return (m ? m[1] : addr).replace(/[,\s]+$/, "").trim() || addr;
}

export const SEED_UNITS = APARTMENTS.map(([n, address]) => {
  const baseRate = Math.round((500 + ((n * 137) % 450)) / 10) * 10; // ₪500–950, deterministic
  return {
    id: `BG-${n}`,
    name: address,
    neighborhood: streetOf(address),
    bedrooms: 1,
    base_rate: baseRate,
    current_rate: baseRate,
    occupancy_30d: 0.7 + ((n * 11) % 26) / 100, // 0.70–0.95
    platform: "Blueground",
  };
});

function seedProfiles(db: Database.Database) {
  const seeded = db
    .prepare("SELECT value FROM meta WHERE key = 'seeded_profiles'")
    .get() as { value: string } | undefined;
  if (seeded?.value === "v1") return;

  const profileId = "prof-telaviv-2g";
  const listingId = "lst-portmamad";
  const airbnbId = "1602229503214826484";
  const now = new Date().toISOString();
  const ts = "2026-06-06T09:00:00.000Z";
  const runId = "seed-proof-run";

  const profile = {
    id: profileId,
    label: "Tel Aviv · 2 guests",
    platform: "Airbnb",
    guests: 2,
    currency: "ILS",
    sw_lat: 32.04,
    sw_lng: 34.74,
    ne_lat: 32.12,
    ne_lng: 34.83,
    zoom: 14,
    stay_nights: JSON.stringify([7, 14, 30]),
    start_dates: JSON.stringify([
      "2026-08-01",
      "2026-08-08",
      "2026-08-15",
      "2026-08-22",
      "2026-09-01",
    ]),
    active: 1,
    created_at: now,
    last_run_at: ts,
  };
  const listing = {
    id: listingId,
    airbnb_id: airbnbId,
    label: "Tel Aviv Port · Mamad High-End Balcony",
    platform: "Airbnb",
    profile_id: profileId,
    unit_id: null as string | null,
    min_nights: 30,
    min_nights_checked_at: ts,
    active: 1,
    created_at: now,
  };
  // The real data point captured during the scraper proof (Aug 1 check-in).
  const snapshots = [
    { stay_label: "1 week", nights: 7, check_in: "2026-08-01", check_out: "2026-08-08",
      eligible: 0, min_nights: 30, found: 0, page: null, position: null, rank: null, total: 280, price: null },
    { stay_label: "2 weeks", nights: 14, check_in: "2026-08-01", check_out: "2026-08-15",
      eligible: 0, min_nights: 30, found: 0, page: null, position: null, rank: null, total: 280, price: null },
    { stay_label: "1 month", nights: 30, check_in: "2026-08-01", check_out: "2026-08-31",
      eligible: 1, min_nights: 30, found: 1, page: 3, position: 15, rank: 51, total: 280, price: 29783 },
  ];

  const insProfile = db.prepare(`
    INSERT INTO search_profiles
      (id, label, platform, guests, currency, sw_lat, sw_lng, ne_lat, ne_lng, zoom, stay_nights, start_dates, active, created_at, last_run_at)
    VALUES
      (@id, @label, @platform, @guests, @currency, @sw_lat, @sw_lng, @ne_lat, @ne_lng, @zoom, @stay_nights, @start_dates, @active, @created_at, @last_run_at)
  `);
  const insListing = db.prepare(`
    INSERT INTO tracked_listings
      (id, airbnb_id, label, platform, profile_id, unit_id, min_nights, min_nights_checked_at, active, created_at)
    VALUES
      (@id, @airbnb_id, @label, @platform, @profile_id, @unit_id, @min_nights, @min_nights_checked_at, @active, @created_at)
  `);
  const insSnap = db.prepare(`
    INSERT INTO listing_snapshots
      (id, listing_id, airbnb_id, profile_id, run_id, ts, stay_label, nights, check_in, check_out, eligible, min_nights, found, page, position, rank, total, price, currency)
    VALUES
      (@id, @listing_id, @airbnb_id, @profile_id, @run_id, @ts, @stay_label, @nights, @check_in, @check_out, @eligible, @min_nights, @found, @page, @position, @rank, @total, @price, @currency)
  `);

  const tx = db.transaction(() => {
    insProfile.run(profile);
    insListing.run(listing);
    for (const s of snapshots) {
      insSnap.run({
        id: randomUUID(),
        listing_id: listingId,
        airbnb_id: airbnbId,
        profile_id: profileId,
        run_id: runId,
        ts,
        currency: "ILS",
        ...s,
      });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_profiles', 'v1')").run();
  });
  tx();
}

// Synthetic competitor ladder for the seeded proof run, so Pricing Intelligence
// renders on a fresh DB before any real scan posts ladder rows. Deterministic and
// clearly demo data: our listing keeps its real captured point (rank 51 @
// ₪29,783); the rest are a plausible Tel-Aviv price ladder where cheaper listings
// tend to rank better (with noise standing in for the non-price factors).
function seedLadder(db: Database.Database) {
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seeded_ladder'").get();
  if (seeded) return;

  const profileId = "prof-telaviv-2g";
  const airbnbId = "1602229503214826484";
  const runId = "seed-proof-run";
  const ts = "2026-06-06T09:00:00.000Z";
  const checkIn = "2026-08-01";
  const checkOut = "2026-08-31";
  const nights = 30;
  const guests = 2;
  const total = 280;
  const currency = "ILS";

  const noise = (k: number) => {
    const x = Math.sin(k * 9301 + 49297) * 233280;
    return x - Math.floor(x); // 0..1, deterministic
  };

  const ins = db.prepare(`
    INSERT INTO search_results
      (id, profile_id, run_id, ts, check_in, check_out, nights, guests, total,
       room_id, rank, page, position, price, price_nightly, currency)
    VALUES
      (@id, @profile_id, @run_id, @ts, @check_in, @check_out, @nights, @guests, @total,
       @room_id, @rank, @page, @position, @price, @price_nightly, @currency)
  `);

  const tx = db.transaction(() => {
    for (let rank = 1; rank <= total; rank++) {
      let priceTotal: number;
      let roomId: string | null = null;
      if (rank === 51) {
        priceTotal = 29783; // our listing's real captured point
        roomId = airbnbId;
      } else {
        const nightly = 620 + 3.4 * rank + (noise(rank) - 0.5) * 520;
        priceTotal = Math.max(9000, Math.round((nightly * nights) / 10) * 10);
      }
      ins.run({
        id: randomUUID(),
        profile_id: profileId,
        run_id: runId,
        ts,
        check_in: checkIn,
        check_out: checkOut,
        nights,
        guests,
        total,
        room_id: roomId,
        rank,
        page: Math.floor((rank - 1) / 18) + 1,
        position: ((rank - 1) % 18) + 1,
        price: priceTotal,
        price_nightly: priceTotal / nights,
        currency,
      });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_ladder', 'v1')").run();
  });
  tx();
}

// A handful of synthetic realized bookings (for a seed unit) so the Outcomes
// surface renders on a fresh DB before the first MiniHotel bookings sync. Spread
// across lead-time buckets + price points to give a pace distribution and a
// realized nightly band. Clearly demo data.
function seedBookings(db: Database.Database) {
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seeded_bookings'").get();
  if (seeded) return;

  const unitId = "BG-2231";
  const now = new Date().toISOString();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const dayMs = 86_400_000;
  // [arrival, leadDays, nightly]
  const samples: Array<[string, number, number]> = [
    ["2026-07-05", 12, 720],
    ["2026-07-12", 9, 700],
    ["2026-07-20", 22, 760],
    ["2026-08-01", 34, 820],
    ["2026-08-10", 28, 800],
    ["2026-08-18", 47, 880],
    ["2026-09-01", 55, 900],
    ["2026-09-12", 41, 860],
    ["2026-09-20", 18, 740],
    ["2026-10-01", 63, 940],
    ["2026-10-10", 30, 810],
    ["2026-07-28", 6, 690],
  ];

  const ins = db.prepare(`
    INSERT INTO bookings
      (id, portal_res_id, unit_id, room_type, source, status, created_on, arrival, departure,
       nights, guests, total, nightly, currency, lead_days, synced_at)
    VALUES
      (@id, @portal_res_id, @unit_id, @room_type, @source, @status, @created_on, @arrival, @departure,
       @nights, @guests, @total, @nightly, @currency, @lead_days, @synced_at)
  `);

  const tx = db.transaction(() => {
    let i = 0;
    for (const [arrival, lead, nightly] of samples) {
      i++;
      const nights = 30;
      const arrMs = Date.parse(`${arrival}T00:00:00Z`);
      ins.run({
        id: `seed-bk-${i}`,
        portal_res_id: `PORTAL-${1000 + i}`,
        unit_id: unitId,
        room_type: null,
        source: i % 2 ? "Airbnb" : "Booking.com",
        status: "OK",
        created_on: iso(arrMs - lead * dayMs),
        arrival,
        departure: iso(arrMs + nights * dayMs),
        nights,
        guests: 2,
        total: nightly * nights,
        nightly,
        currency: "ILS",
        lead_days: lead,
        synced_at: now,
      });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_bookings', 'v1')").run();
    // Link the seeded listing to the seeded unit so the demo bookings attribute
    // (booking → unit → listing → its scans). Touches only the seed row.
    db.prepare(
      "UPDATE tracked_listings SET unit_id = 'BG-2231' WHERE id = 'lst-portmamad' AND unit_id IS NULL",
    ).run();
  });
  tx();
}

export function getDb(): Database.Database {
  if (global.__rohubDb) return global.__rohubDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  seed(db);
  seedProfiles(db);
  seedLadder(db);
  seedBookings(db);
  global.__rohubDb = db;
  return db;
}
