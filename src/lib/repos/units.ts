import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { parseUnitsCsv, type FieldKey, type ParsedUnit } from "@/lib/units-import";

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

// ---------------------------------------------------------------- mutations
export function deleteUnit(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM pricing_history WHERE unit_id = ?").run(id);
    db.prepare("DELETE FROM units WHERE id = ?").run(id);
  });
  tx();
}

// ---------------------------------------------------------------- CSV import
const FIELD_TO_COL: Record<FieldKey, string> = {
  id: "id",
  name: "name",
  neighborhood: "neighborhood",
  bedrooms: "bedrooms",
  baseRate: "base_rate",
  currentRate: "current_rate",
  occupancy30d: "occupancy_30d",
  platform: "platform",
};

export interface UnitImportRowResult {
  line: number;
  status: "create" | "update" | "error";
  id?: string;
  name?: string;
  error?: string;
  unit?: ParsedUnit; // coerced values, so the preview can show exactly what lands
}

export interface UnitImportResult {
  committed: boolean;
  delimiter: string;
  headers: string[];
  mapping: Record<string, string | null>;
  present: FieldKey[];
  unmapped: string[];
  total: number;
  valid: number;
  errors: number;
  created: number;
  updated: number;
  rows: UnitImportRowResult[];
}

function genUnitId(db: ReturnType<typeof getDb>): string {
  const exists = db.prepare("SELECT 1 FROM units WHERE id = ?");
  for (let i = 0; i < 50; i++) {
    const id = "BG-" + Math.floor(1000 + Math.random() * 9000);
    if (!exists.get(id)) return id;
  }
  return "BG-" + randomUUID().slice(0, 8);
}

// Parse pasted CSV/TSV and (optionally) upsert into `units`. Existing rows are
// matched by id when the sheet provides one, otherwise by case-insensitive
// name — so re-importing the same sheet updates in place instead of duplicating.
// Updates only touch columns the sheet actually carried, so a sheet without a
// rate column never zeroes out rates the pricing agent has already set.
export function importUnits(text: string, commit: boolean): UnitImportResult {
  const parsed = parseUnitsCsv(text);
  const db = getDb();

  const findById = db.prepare("SELECT id FROM units WHERE id = ?");
  const findByName = db.prepare("SELECT id FROM units WHERE lower(name) = lower(?)");

  const plan = parsed.rows.map((row) => {
    if (!row.unit) return { row, action: "error" as const, id: undefined as string | undefined };
    const u = row.unit;
    const hit = (u.id ? findById.get(u.id) : findByName.get(u.name)) as
      | { id: string }
      | undefined;
    return {
      row,
      action: hit ? ("update" as const) : ("create" as const),
      id: hit?.id ?? u.id ?? undefined,
    };
  });

  const insert = db.prepare(`
    INSERT INTO units (id, name, neighborhood, bedrooms, base_rate, current_rate, occupancy_30d, platform)
    VALUES (@id, @name, @neighborhood, @bedrooms, @base_rate, @current_rate, @occupancy_30d, @platform)
  `);
  const updatableCols = parsed.present.filter((k) => k !== "id");
  const updateStmt =
    updatableCols.length > 0
      ? db.prepare(
          `UPDATE units SET ${updatableCols
            .map((k) => `${FIELD_TO_COL[k]} = @${k}`)
            .join(", ")} WHERE id = @id`,
        )
      : null;

  const runInsert = (id: string, u: ParsedUnit) =>
    insert.run({
      id,
      name: u.name,
      neighborhood: u.neighborhood,
      bedrooms: u.bedrooms,
      base_rate: u.baseRate,
      current_rate: u.currentRate,
      occupancy_30d: u.occupancy30d,
      platform: u.platform,
    });

  const runUpdate = (id: string, u: ParsedUnit) => {
    if (!updateStmt) return;
    const params: Record<string, unknown> = { id };
    for (const k of updatableCols) params[k] = u[k];
    updateStmt.run(params);
  };

  if (commit) {
    const apply = db.transaction(() => {
      for (const p of plan) {
        if (p.action === "error" || !p.row.unit) continue;
        if (p.action === "create") runInsert(p.id ?? genUnitId(db), p.row.unit);
        else runUpdate(p.id as string, p.row.unit);
      }
    });
    apply();
  }

  let created = 0;
  let updated = 0;
  const rows: UnitImportRowResult[] = plan.map((p) => {
    if (p.action === "error") {
      return { line: p.row.line, status: "error", error: p.row.error ?? "invalid row" };
    }
    if (p.action === "create") {
      created++;
      return { line: p.row.line, status: "create", id: p.id, name: p.row.unit?.name, unit: p.row.unit ?? undefined };
    }
    updated++;
    return { line: p.row.line, status: "update", id: p.id, name: p.row.unit?.name, unit: p.row.unit ?? undefined };
  });

  return {
    committed: commit,
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    mapping: parsed.mapping,
    present: parsed.present,
    unmapped: parsed.unmapped,
    total: parsed.rows.length,
    valid: parsed.valid,
    errors: parsed.errors,
    created,
    updated,
    rows,
  };
}
