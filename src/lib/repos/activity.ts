import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { ActivityEvent } from "@/lib/mock-data";

export function listActivity(limit = 50): ActivityEvent[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, ts, department, worker, message, level FROM activity_events ORDER BY ts DESC LIMIT ?",
    )
    .all(limit) as ActivityEvent[];
}

export function logActivity(
  evt: Omit<ActivityEvent, "id" | "ts"> & { id?: string; ts?: string },
): ActivityEvent {
  const db = getDb();
  const row: ActivityEvent = {
    id: evt.id ?? `evt-${randomUUID().slice(0, 8)}`,
    ts: evt.ts ?? new Date().toISOString(),
    department: evt.department,
    worker: evt.worker,
    message: evt.message,
    level: evt.level,
  };
  db.prepare(
    "INSERT INTO activity_events (id, ts, department, worker, message, level) VALUES (@id, @ts, @department, @worker, @message, @level)",
  ).run(row);
  return row;
}
