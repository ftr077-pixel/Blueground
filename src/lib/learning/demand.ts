// Relative demand index. External market readings (e.g. "market occupancy 30%"
// from a PriceLabs-style dashboard) are unreliable in ABSOLUTE terms — Tel Aviv
// carries many ghost/zombie listings that are never booked, dragging the level
// down. The operator's observed reality: the dashboard reads 30% while their own
// portfolio runs ~100%. So a reading is interpreted RELATIVELY: its percentile
// within the same source's own rolling history for the area. If 30% is the top
// of the range this metric ever reads, 30% means HOT.
//
// Components, each −1..+1 (0 = typical):
//   market   — percentile of the latest external reading for the stay date
//   supply   — inverted percentile of the current search field size (`total`)
//              for the segment vs. its own history (thin field = hot)
// Blended = mean of available components. Our own realized occupancy around the
// date (rate_calendar, MiniHotel-fed) is reported beside it as the truth anchor.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getProfile } from "@/lib/repos/visibility";
import { DEMAND, leadBucketOf } from "./config";

export type DemandLabel = "hot" | "firm" | "soft" | "cold";

export interface DemandComponent {
  index: number; // −1..+1
  percentile: number; // 0..100 within its own history
  raw: number; // the raw reading (occupancy % / field size)
  n: number; // history size the percentile is computed against
}

export interface DemandSignal {
  area: string;
  date: string;
  index: number | null; // blended −1..+1; null when nothing is known
  label: DemandLabel | null;
  market: DemandComponent | null;
  supply: DemandComponent | null;
  ourOccupancy: number | null; // 0..1 realized around the date (null = no data)
  readingTs: string | null; // when the market reading was taken
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function labelOf(index: number): DemandLabel {
  if (index >= DEMAND.hotThreshold) return "hot";
  if (index >= 0) return "firm";
  if (index > -DEMAND.hotThreshold) return "soft";
  return "cold";
}

// Strictly-less share → percentile (ties count half, so a constant series ⇒ p50).
function percentileOf(value: number, history: number[]): number {
  if (!history.length) return 50;
  let less = 0;
  let equal = 0;
  for (const h of history) {
    if (h < value) less++;
    else if (h === value) equal++;
  }
  return ((less + equal / 2) / history.length) * 100;
}

// ---------------------------------------------------------------- ingest
export interface DemandReadingInput {
  area: string;
  source?: string;
  readings: Array<{ date: string; value: number }>;
}

export function recordDemandReadings(input: DemandReadingInput): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO demand_readings (id, area, date, source, value, ts)
     VALUES (@id, @area, @date, @source, @value, @ts)`,
  );
  const ts = new Date().toISOString();
  const source = (input.source ?? "market-occupancy").trim();
  const area = input.area.trim();
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of input.readings) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.value)) continue;
      ins.run({ id: randomUUID(), area, date: r.date, source, value: r.value, ts });
      n++;
    }
  });
  tx();
  return n;
}

// Paste-friendly: one "YYYY-MM-DD value" (or csv "date,value") per line.
export function parseDemandText(text: string): Array<{ date: string; value: number }> {
  const out: Array<{ date: string; value: number }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/(\d{4}-\d{2}-\d{2})[\s,;\t]+([\d.]+)/);
    if (!m) continue;
    const value = parseFloat(m[2]);
    if (Number.isFinite(value)) out.push({ date: m[1], value });
  }
  return out;
}

// ---------------------------------------------------------------- components
interface ReadingRow {
  date: string;
  value: number;
  ts: string;
}

// Latest reading for the stay date + the source's own history for the area.
function marketComponent(
  area: string,
  date: string,
  source = "market-occupancy",
): { comp: DemandComponent | null; readingTs: string | null } {
  const db = getDb();
  const latest = db
    .prepare(
      `SELECT date, value, ts FROM demand_readings
        WHERE area = ? AND source = ? AND date = ?
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(area, source, date) as ReadingRow | undefined;
  if (!latest) return { comp: null, readingTs: null };

  const cutoff = new Date(Date.now() - DEMAND.historyDays * 86_400_000).toISOString();
  const history = (
    db
      .prepare(
        `SELECT value FROM demand_readings
          WHERE area = ? AND source = ? AND ts >= ?`,
      )
      .all(area, source, cutoff) as Array<{ value: number }>
  ).map((r) => r.value);
  if (history.length < DEMAND.minReadings) return { comp: null, readingTs: latest.ts };

  const pct = percentileOf(latest.value, history);
  return {
    comp: {
      index: round2((pct / 100) * 2 - 1),
      percentile: Math.round(pct),
      raw: latest.value,
      n: history.length,
    },
    readingTs: latest.ts,
  };
}

// Field size now vs. its own history in the same lead bucket — thin = hot.
function supplyComponent(profileId: string, nights: number, checkIn: string): DemandComponent | null {
  const db = getDb();
  const current = db
    .prepare(
      `SELECT total, ts FROM search_results
        WHERE profile_id = ? AND nights = ? AND check_in = ? AND total > 0
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(profileId, nights, checkIn) as { total: number; ts: string } | undefined;
  if (!current) return null;

  const lead = Math.max(
    0,
    Math.round((Date.parse(`${checkIn}T00:00:00Z`) - Date.parse(current.ts)) / 86_400_000),
  );
  const bucket = leadBucketOf(lead);
  // One representative total per search (run × check-in) in the same lead bucket.
  const history = (
    db
      .prepare(
        `SELECT MAX(total) AS total FROM search_results
          WHERE profile_id = ? AND nights = ? AND total > 0
            AND (julianday(check_in) - julianday(ts)) >= ? AND (julianday(check_in) - julianday(ts)) <= ?
          GROUP BY run_id, check_in`,
      )
      .all(profileId, nights, bucket.min, bucket.max) as Array<{ total: number }>
  ).map((r) => r.total);
  if (history.length < DEMAND.minReadings) return null;

  const pct = percentileOf(current.total, history);
  return {
    // More listings on the market = LESS demand pressure → invert.
    index: round2(-((pct / 100) * 2 - 1)),
    percentile: Math.round(pct),
    raw: current.total,
    n: history.length,
  };
}

// Realized portfolio occupancy around a stay date, from real calendar overrides
// (MiniHotel writes booked=0/1; the deterministic demo baseline is excluded).
export function ourOccupancyAround(date: string, spanDays = DEMAND.ourOccSpanDays): number | null {
  const db = getDb();
  const d0 = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(d0)) return null;
  const from = new Date(d0 - spanDays * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(d0 + spanDays * 86_400_000).toISOString().slice(0, 10);
  const row = db
    .prepare(
      `SELECT SUM(booked) AS b, COUNT(*) AS n FROM rate_calendar
        WHERE date >= ? AND date <= ? AND booked IS NOT NULL`,
    )
    .get(from, to) as { b: number | null; n: number };
  if (!row.n) return null;
  return round2((row.b ?? 0) / row.n);
}

// ---------------------------------------------------------------- public API
export function demandSignal(profileId: string, nights: number, checkIn: string): DemandSignal {
  const area = getProfile(profileId)?.label ?? profileId;
  const { comp: market, readingTs } = marketComponent(area, checkIn);
  const supply = supplyComponent(profileId, nights, checkIn);
  const parts = [market?.index, supply?.index].filter((v): v is number => v != null);
  const index = parts.length ? round2(parts.reduce((s, v) => s + v, 0) / parts.length) : null;
  return {
    area,
    date: checkIn,
    index,
    label: index != null ? labelOf(index) : null,
    market,
    supply,
    ourOccupancy: ourOccupancyAround(checkIn),
    readingTs,
  };
}

// Area-level overview: a signal per upcoming date we know anything about
// (external readings ∪ scanned check-ins), soonest first.
export function demandSummary(profileId: string, nights: number, limit = 12): DemandSignal[] {
  const db = getDb();
  const area = getProfile(profileId)?.label ?? profileId;
  const today = new Date().toISOString().slice(0, 10);
  const fromReadings = db
    .prepare(
      `SELECT DISTINCT date FROM demand_readings WHERE area = ? AND date >= ? ORDER BY date LIMIT ?`,
    )
    .all(area, today, limit) as Array<{ date: string }>;
  const fromScans = db
    .prepare(
      `SELECT DISTINCT check_in AS date FROM search_results
        WHERE profile_id = ? AND nights = ? AND check_in >= ? ORDER BY check_in LIMIT ?`,
    )
    .all(profileId, nights, today, limit) as Array<{ date: string }>;
  const dates = Array.from(new Set([...fromReadings, ...fromScans].map((r) => r.date)))
    .sort()
    .slice(0, limit);
  return dates.map((d) => demandSignal(profileId, nights, d));
}
