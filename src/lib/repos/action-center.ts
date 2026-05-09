import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

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
}

interface DecisionSql {
  id: string;
  item_id: string;
  outcome: DecisionRow["outcome"];
  decided_at: string;
  decided_by: string | null;
}

function rowToItem(r: ItemSql): ApprovalItemRow {
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
              a.blast_radius, a.amount, a.raised_at, a.rule
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
    }),
  }));
}

export function decide(
  itemId: string,
  outcome: "approved" | "rejected",
  decidedBy: string | null = null,
): DecisionRow {
  const db = getDb();
  const item = db.prepare("SELECT id FROM approval_items WHERE id = ?").get(itemId);
  if (!item) throw new Error(`approval item ${itemId} not found`);
  const existing = db
    .prepare("SELECT id FROM decisions WHERE item_id = ?")
    .get(itemId) as { id: string } | undefined;
  if (existing) throw new Error(`item ${itemId} already decided`);
  const row: DecisionRow = {
    id: randomUUID(),
    itemId,
    outcome,
    decidedAt: new Date().toISOString(),
    decidedBy,
  };
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
  return row;
}

export function createApprovalItem(input: Omit<ApprovalItemRow, "id" | "raisedAt"> & {
  id?: string;
  raisedAt?: string;
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
  };
  db.prepare(
    `INSERT INTO approval_items (id, department, worker, proposed_action, rationale, blast_radius, amount, raised_at, rule, payload)
     VALUES (@id, @department, @worker, @proposed_action, @rationale, @blast_radius, @amount, @raised_at, @rule, NULL)`,
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
  });
  return row;
}
