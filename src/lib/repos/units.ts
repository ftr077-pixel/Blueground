import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

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
