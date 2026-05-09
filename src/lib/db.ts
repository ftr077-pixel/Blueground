import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { ACTIVITY_FEED, DEPARTMENTS } from "@/lib/mock-data";
import { APPROVAL_QUEUE } from "@/lib/synthesis-data";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "orchestrator.db");

declare global {
  // eslint-disable-next-line no-var
  var __rohubDb: Database.Database | undefined;
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

    CREATE TABLE IF NOT EXISTS orchestrator_runs (
      id            TEXT PRIMARY KEY,
      workspace     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      state         TEXT NOT NULL,
      phase         TEXT NOT NULL,
      turn_count    INTEGER NOT NULL DEFAULT 0,
      driver        TEXT NOT NULL DEFAULT 'scripted'
    );

    CREATE TABLE IF NOT EXISTS orchestrator_turns (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES orchestrator_runs(id),
      seq           INTEGER NOT NULL,
      turn          INTEGER NOT NULL,
      role          TEXT NOT NULL,
      ts            TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT NOT NULL,
      artifacts     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_run_seq ON orchestrator_turns(run_id, seq);

    CREATE TABLE IF NOT EXISTS orchestrator_lines (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES orchestrator_runs(id),
      seq           INTEGER NOT NULL,
      ts            TEXT NOT NULL,
      stream        TEXT NOT NULL,
      text          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lines_run_seq ON orchestrator_lines(run_id, seq);

    CREATE TABLE IF NOT EXISTS meta (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL
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

export function getDb(): Database.Database {
  if (global.__rohubDb) return global.__rohubDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  seed(db);
  global.__rohubDb = db;
  return db;
}
