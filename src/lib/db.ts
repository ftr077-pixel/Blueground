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
      min_nights    TEXT
    );
  `);
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

export const SEED_UNITS = [
  {
    id: "BG-2231",
    name: "Rothschild 14 · Studio",
    neighborhood: "Lev HaIr",
    bedrooms: 0,
    base_rate: 720,
    current_rate: 720,
    occupancy_30d: 0.91,
    platform: "Blueground",
  },
  {
    id: "BG-2244",
    name: "Shabazi 41 · 2BR",
    neighborhood: "Neve Tzedek",
    bedrooms: 2,
    base_rate: 1180,
    current_rate: 1180,
    occupancy_30d: 0.94,
    platform: "Blueground",
  },
  {
    id: "BG-2289",
    name: "Florentin Loft · 1BR",
    neighborhood: "Florentin",
    bedrooms: 1,
    base_rate: 640,
    current_rate: 640,
    occupancy_30d: 0.88,
    platform: "Blueground",
  },
  {
    id: "BG-2305",
    name: "Allenby 88 · 1BR",
    neighborhood: "Lev HaIr",
    bedrooms: 1,
    base_rate: 690,
    current_rate: 690,
    occupancy_30d: 0.83,
    platform: "Airbnb",
  },
  {
    id: "BG-2330",
    name: "Kerem HaTeimanim 7 · 2BR",
    neighborhood: "Kerem HaTeimanim",
    bedrooms: 2,
    base_rate: 1020,
    current_rate: 1020,
    occupancy_30d: 0.95,
    platform: "Blueground",
  },
  {
    id: "BG-2351",
    name: "Dizengoff 142 · Studio",
    neighborhood: "Lev HaIr",
    bedrooms: 0,
    base_rate: 660,
    current_rate: 660,
    occupancy_30d: 0.86,
    platform: "Blueground",
  },
];

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

export function getDb(): Database.Database {
  if (global.__rohubDb) return global.__rohubDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  seed(db);
  seedProfiles(db);
  seedLadder(db);
  global.__rohubDb = db;
  return db;
}
