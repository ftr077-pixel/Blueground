import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { setUnitRate, setPricingStatus } from "@/lib/repos/units";
import { logActivity } from "@/lib/repos/activity";

/** Machine-readable action an approval item carries so approving it can actually execute it. */
export interface PricingMovePayload {
  kind: "pricing_move";
  unitId: string;
  newRate: number;
  historyId: string;
}

export interface ApprovalItemRow {
  id: string;
  department: "revenue" | "logistics" | "guest" | "growth";
  worker: string;
  proposedAction: string;
  rationale: string;
  blastRadius: "low" | "medium" | "high";
  amount: string | null;
  raisedAt: string;
  rule: string;
  /** Parsed `payload` column (e.g. a PricingMovePayload); null for prose-only items. */
  payload: Record<string, unknown> | null;
}

export interface DecisionRow {
  id: string;
  itemId: string;
  outcome: "approved" | "rejected";
  decidedAt: string;
  decidedBy: string | null;
}

interface ItemSql {
  id: string;
  department: ApprovalItemRow["department"];
  worker: string;
  proposed_action: string;
  rationale: string;
  blast_radius: ApprovalItemRow["blastRadius"];
  amount: string | null;
  raised_at: string;
  rule: string;
  payload: string | null;
}

interface DecisionSql {
  id: string;
  item_id: string;
  outcome: DecisionRow["outcome"];
  decided_at: string;
  decided_by: string | null;
}

function rowToItem(r: ItemSql): ApprovalItemRow {
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    department: r.department,
    worker: r.worker,
    proposedAction: r.proposed_action,
    rationale: r.rationale,
    blastRadius: r.blast_radius,
    amount: r.amount,
    raisedAt: r.raised_at,
    rule: r.rule,
    payload,
  };
}

export function listApprovalItems(): ApprovalItemRow[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM approval_items ORDER BY raised_at DESC").all() as ItemSql[])
    .map(rowToItem);
}

export function listPending(): ApprovalItemRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.* FROM approval_items a
         LEFT JOIN decisions d ON d.item_id = a.id
         WHERE d.id IS NULL
         ORDER BY a.raised_at DESC`,
    )
    .all() as ItemSql[];
  return rows.map(rowToItem);
}

export function listDecisions(): DecisionRow[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM decisions ORDER BY decided_at DESC")
    .all() as DecisionSql[];
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    outcome: r.outcome,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  }));
}

export interface DecisionWithItem extends DecisionRow {
  item: ApprovalItemRow;
}

export function listDecisionsWithItems(): DecisionWithItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.*, a.department, a.worker, a.proposed_action, a.rationale,
              a.blast_radius, a.amount, a.raised_at, a.rule, a.payload
         FROM decisions d
         JOIN approval_items a ON a.id = d.item_id
        ORDER BY d.decided_at DESC`,
    )
    .all() as (DecisionSql & ItemSql)[];
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    outcome: r.outcome,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    item: rowToItem({
      id: r.item_id,
      department: r.department,
      worker: r.worker,
      proposed_action: r.proposed_action,
      rationale: r.rationale,
      blast_radius: r.blast_radius,
      amount: r.amount,
      raised_at: r.raised_at,
      rule: r.rule,
      payload: r.payload,
    }),
  }));
}

/** Extract a valid pricing-move payload from an item, or null. */
function pricingMoveOf(item: ApprovalItemRow): PricingMovePayload | null {
  const p = item.payload as Partial<PricingMovePayload> | null;
  if (
    p &&
    p.kind === "pricing_move" &&
    typeof p.unitId === "string" &&
    typeof p.historyId === "string" &&
    typeof p.newRate === "number" &&
    Number.isFinite(p.newRate) &&
    p.newRate > 0
  ) {
    return p as PricingMovePayload;
  }
  return null;
}

export function decide(
  itemId: string,
  outcome: "approved" | "rejected",
  decidedBy: string | null = null,
): DecisionRow {
  const db = getDb();
  const itemRow = db.prepare("SELECT * FROM approval_items WHERE id = ?").get(itemId) as
    | ItemSql
    | undefined;
  if (!itemRow) throw new Error(`approval item ${itemId} not found`);
  const existing = db
    .prepare("SELECT id FROM decisions WHERE item_id = ?")
    .get(itemId) as { id: string } | undefined;
  if (existing) throw new Error(`item ${itemId} already decided`);
  const item = rowToItem(itemRow);
  const row: DecisionRow = {
    id: randomUUID(),
    itemId,
    outcome,
    decidedAt: new Date().toISOString(),
    decidedBy,
  };
  // Recording the decision and executing the approved action are one atomic
  // step: an approval the operator sees as "done" must not leave the rate
  // unapplied (the old behavior — the gate recorded the click and did nothing,
  // so the same move re-escalated forever).
  const move = pricingMoveOf(item);
  let applied = false;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO decisions (id, item_id, outcome, decided_at, decided_by)
       VALUES (@id, @item_id, @outcome, @decided_at, @decided_by)`,
    ).run({
      id: row.id,
      item_id: row.itemId,
      outcome: row.outcome,
      decided_at: row.decidedAt,
      decided_by: row.decidedBy,
    });
    if (move) {
      if (outcome === "approved") {
        // The unit may have been deleted/re-imported since the escalation.
        const unit = db.prepare("SELECT id FROM units WHERE id = ?").get(move.unitId);
        if (unit) {
          setUnitRate(move.unitId, move.newRate, row.decidedAt);
          setPricingStatus(move.historyId, "applied");
          applied = true;
        }
      } else {
        setPricingStatus(move.historyId, "rejected");
      }
    }
  });
  tx();
  if (move) {
    logActivity({
      department: item.department,
      worker: item.worker,
      message:
        outcome === "approved"
          ? applied
            ? `Approved: ${item.proposedAction} Rate applied.`
            : `Approved: ${item.proposedAction} Unit no longer exists — nothing applied.`
          : `Rejected: ${item.proposedAction}`,
      level: outcome === "approved" ? "success" : "info",
    });
  }
  return row;
}

export function createApprovalItem(input: Omit<ApprovalItemRow, "id" | "raisedAt" | "payload"> & {
  id?: string;
  raisedAt?: string;
  payload?: Record<string, unknown> | null;
}): ApprovalItemRow {
  const db = getDb();
  const row: ApprovalItemRow = {
    id: input.id ?? `ac-${randomUUID().slice(0, 8)}`,
    department: input.department,
    worker: input.worker,
    proposedAction: input.proposedAction,
    rationale: input.rationale,
    blastRadius: input.blastRadius,
    amount: input.amount,
    raisedAt: input.raisedAt ?? new Date().toISOString(),
    rule: input.rule,
    payload: input.payload ?? null,
  };
  db.prepare(
    `INSERT INTO approval_items (id, department, worker, proposed_action, rationale, blast_radius, amount, raised_at, rule, payload)
     VALUES (@id, @department, @worker, @proposed_action, @rationale, @blast_radius, @amount, @raised_at, @rule, @payload)`,
  ).run({
    id: row.id,
    department: row.department,
    worker: row.worker,
    proposed_action: row.proposedAction,
    rationale: row.rationale,
    blast_radius: row.blastRadius,
    amount: row.amount,
    raised_at: row.raisedAt,
    rule: row.rule,
    payload: row.payload ? JSON.stringify(row.payload) : null,
  });
  return row;
}
