import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { UNIT_PRICING_DEFAULTS, roundRate } from "@/lib/config/pricing";

export interface Unit {
  id: string;
  name: string;
  neighborhood: string;
  bedrooms: number;
  baseRate: number;
  currentRate: number;
  occupancy30d: number;
  platform: string;
  lastRateChangeAt: string | null;
  /** Price floor — the agent never recommends below this (PriceLabs "min price"). */
  minRate: number;
  /** Price ceiling — caps surge/far-out premiums (PriceLabs "max price"). */
  maxRate: number;
  /** LOS discount for 7+ night stays (0..1). */
  weeklyDiscountPct: number;
  /** LOS discount for ~30 night stays (0..1) — the headline MTR lever. */
  monthlyDiscountPct: number;
  /** Current recommended minimum stay in nights (flexes with demand). */
  minStay: number;
  /** Hard minimum-stay floor — what makes the unit mid-term (e.g. 30). */
  lowestMinStay: number;
  /** MiniHotel room-type code this unit maps to (names differ between systems). */
  minihotelRoomType: string | null;
}

export interface PricingHistoryRow {
  id: string;
  unitId: string;
  ts: string;
  oldRate: number;
  newRate: number;
  deltaPct: number;
  reason: string;
  signals: Record<string, unknown>;
  status: "applied" | "pending_approval" | "rejected";
}

interface UnitSql {
  id: string;
  name: string;
  neighborhood: string;
  bedrooms: number;
  base_rate: number;
  current_rate: number;
  occupancy_30d: number;
  platform: string;
  last_rate_change_at: string | null;
  min_rate: number | null;
  max_rate: number | null;
  weekly_discount_pct: number | null;
  monthly_discount_pct: number | null;
  min_stay: number | null;
  lowest_min_stay: number | null;
  minihotel_room_type: string | null;
}

interface HistorySql {
  id: string;
  unit_id: string;
  ts: string;
  old_rate: number;
  new_rate: number;
  delta_pct: number;
  reason: string;
  signals: string;
  status: PricingHistoryRow["status"];
}

function rowToUnit(r: UnitSql): Unit {
  // Coalesce defaults so reads are safe even if a migration backfill hasn't run.
  return {
    id: r.id,
    name: r.name,
    neighborhood: r.neighborhood,
    bedrooms: r.bedrooms,
    baseRate: r.base_rate,
    currentRate: r.current_rate,
    occupancy30d: r.occupancy_30d,
    platform: r.platform,
    lastRateChangeAt: r.last_rate_change_at,
    minRate: r.min_rate ?? roundRate(r.base_rate * UNIT_PRICING_DEFAULTS.floorPctOfBase),
    maxRate: r.max_rate ?? roundRate(r.base_rate * UNIT_PRICING_DEFAULTS.ceilingPctOfBase),
    weeklyDiscountPct: r.weekly_discount_pct ?? UNIT_PRICING_DEFAULTS.weeklyDiscountPct,
    monthlyDiscountPct: r.monthly_discount_pct ?? UNIT_PRICING_DEFAULTS.monthlyDiscountPct,
    minStay: r.min_stay ?? UNIT_PRICING_DEFAULTS.minStay,
    lowestMinStay: r.lowest_min_stay ?? UNIT_PRICING_DEFAULTS.lowestMinStay,
    minihotelRoomType: r.minihotel_room_type ?? null,
  };
}

export function listUnits(): Unit[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM units ORDER BY name").all() as UnitSql[]).map(rowToUnit);
}

export function setUnitRate(unitId: string, newRate: number, ts: string) {
  const db = getDb();
  db.prepare(
    "UPDATE units SET current_rate = ?, last_rate_change_at = ? WHERE id = ?",
  ).run(newRate, ts, unitId);
}

export function setUnitMinStay(unitId: string, minStay: number) {
  const db = getDb();
  db.prepare("UPDATE units SET min_stay = ? WHERE id = ?").run(minStay, unitId);
}

// Seed a unit's base/current/floor/ceiling from a rate anchor (e.g. derived from
// the Rates Calendar / MiniHotel) — only for units that don't have a base rate
// yet, so we never clobber an existing one.
export function setUnitRateAnchor(
  unitId: string,
  base: number,
  current: number,
  minRate: number,
  maxRate: number,
) {
  const db = getDb();
  db.prepare(
    `UPDATE units SET base_rate = ?, current_rate = ?, min_rate = ?, max_rate = ?,
       last_rate_change_at = ? WHERE id = ? AND base_rate <= 0`,
  ).run(base, current, minRate, maxRate, new Date().toISOString(), unitId);
}

export function setUnitMiniHotelRoomType(unitId: string, code: string | null) {
  const db = getDb();
  db.prepare("UPDATE units SET minihotel_room_type = ? WHERE id = ?").run(code, unitId);
}

/** Create/refresh a unit imported from MiniHotel (rates fill in on the first Sync). */
export function upsertImportedUnit(u: {
  id: string;
  name: string;
  platform: string;
  minihotelRoomType: string;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO units (id, name, neighborhood, bedrooms, base_rate, current_rate, occupancy_30d, platform, minihotel_room_type)
     VALUES (@id, @name, '', 0, 0, 0, 0, @platform, @minihotel_room_type)
     ON CONFLICT(id) DO UPDATE SET name = @name, platform = @platform, minihotel_room_type = @minihotel_room_type`,
  ).run({ id: u.id, name: u.name, platform: u.platform, minihotel_room_type: u.minihotelRoomType });
}

/** Delete units whose id starts with `prefix`, cleaning their FK-referencing rows first. */
export function deleteUnitsByIdPrefix(prefix: string): number {
  const db = getDb();
  const like = prefix + "%";
  const n = (db.prepare("SELECT COUNT(*) AS c FROM units WHERE id LIKE ?").get(like) as { c: number }).c;
  if (n === 0) return 0;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM rate_calendar WHERE unit_id LIKE ?").run(like);
    db.prepare("DELETE FROM pricing_history WHERE unit_id LIKE ?").run(like);
    db.prepare("UPDATE tracked_searches SET unit_id = NULL WHERE unit_id LIKE ?").run(like);
    db.prepare("UPDATE tracked_listings SET unit_id = NULL WHERE unit_id LIKE ?").run(like);
    db.prepare("UPDATE reservation SET unit_id = NULL WHERE unit_id LIKE ?").run(like);
    db.prepare("DELETE FROM units WHERE id LIKE ?").run(like);
  });
  tx();
  return n;
}

/** Delete one unit, cleaning its FK rows (rate_calendar, pricing_history) and
 *  nulling soft references (tracked_*, reservation) first. */
export function deleteUnit(unitId: string): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM units WHERE id = ?").get(unitId)) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM rate_calendar WHERE unit_id = ?").run(unitId);
    db.prepare("DELETE FROM pricing_history WHERE unit_id = ?").run(unitId);
    db.prepare("UPDATE tracked_searches SET unit_id = NULL WHERE unit_id = ?").run(unitId);
    db.prepare("UPDATE tracked_listings SET unit_id = NULL WHERE unit_id = ?").run(unitId);
    db.prepare("UPDATE reservation SET unit_id = NULL WHERE unit_id = ?").run(unitId);
    db.prepare("DELETE FROM units WHERE id = ?").run(unitId);
  });
  tx();
  return true;
}

export function recordPricing(
  input: Omit<PricingHistoryRow, "id" | "ts" | "signals"> & {
    signals: Record<string, unknown>;
    ts?: string;
  },
): PricingHistoryRow {
  const db = getDb();
  const row: PricingHistoryRow = {
    id: randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    unitId: input.unitId,
    oldRate: input.oldRate,
    newRate: input.newRate,
    deltaPct: input.deltaPct,
    reason: input.reason,
    signals: input.signals,
    status: input.status,
  };
  db.prepare(
    `INSERT INTO pricing_history (id, unit_id, ts, old_rate, new_rate, delta_pct, reason, signals, status)
     VALUES (@id, @unit_id, @ts, @old_rate, @new_rate, @delta_pct, @reason, @signals, @status)`,
  ).run({
    id: row.id,
    unit_id: row.unitId,
    ts: row.ts,
    old_rate: row.oldRate,
    new_rate: row.newRate,
    delta_pct: row.deltaPct,
    reason: row.reason,
    signals: JSON.stringify(row.signals),
    status: row.status,
  });
  return row;
}

/** Flip a history row's status when its escalation is decided (approved/rejected). */
export function setPricingStatus(historyId: string, status: PricingHistoryRow["status"]): void {
  const db = getDb();
  db.prepare("UPDATE pricing_history SET status = ? WHERE id = ?").run(status, historyId);
}

export function listPricingHistory(unitId?: string, limit = 50): PricingHistoryRow[] {
  const db = getDb();
  const rows = (
    unitId
      ? (db
          .prepare(
            "SELECT * FROM pricing_history WHERE unit_id = ? ORDER BY ts DESC LIMIT ?",
          )
          .all(unitId, limit) as HistorySql[])
      : (db
          .prepare("SELECT * FROM pricing_history ORDER BY ts DESC LIMIT ?")
          .all(limit) as HistorySql[])
  ).map((r) => ({
    id: r.id,
    unitId: r.unit_id,
    ts: r.ts,
    oldRate: r.old_rate,
    newRate: r.new_rate,
    deltaPct: r.delta_pct,
    reason: r.reason,
    signals: JSON.parse(r.signals) as Record<string, unknown>,
    status: r.status,
  }));
  return rows;
}
