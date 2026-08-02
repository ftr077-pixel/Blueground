"""Durable call records (SPEC A9).

SQLite through the standard library. One box, a handful of operators, and a
row written once when a call ends — a database server would be more moving
parts than the data justifies. The schema is plain SQL so that M3's move to
Postgres is a data copy rather than a rewrite.

Writes happen after the call, never during it: nothing here may run on the
media path.
"""

import asyncio
import json
import sqlite3
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    operator      TEXT NOT NULL,
    started_at    REAL NOT NULL,
    ended_at      REAL NOT NULL,
    direction     TEXT NOT NULL,
    counterparty  TEXT NOT NULL DEFAULT '',
    turns         TEXT NOT NULL,
    stats         TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    action_items  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS calls_by_operator ON calls (operator, started_at DESC);
"""


@dataclass(frozen=True, slots=True)
class CallRecord:
    id: str
    session_id: str
    operator: str
    started_at: float
    ended_at: float
    direction: str
    counterparty: str
    turns: list[dict[str, Any]] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    action_items: list[str] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return max(0.0, self.ended_at - self.started_at)


def new_call_id() -> str:
    return uuid.uuid4().hex


class CallStore:
    """Every method is async and does its SQL in a worker thread.

    sqlite3 is synchronous, and a disk write that blocks the event loop is
    audible as a stutter on any call still in progress.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        # Readers must not block on the post-call writer.
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    async def save(self, record: CallRecord) -> None:
        def write() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO calls (id, session_id, operator, started_at,"
                    " ended_at, direction, counterparty, turns, stats, summary, action_items)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.id,
                        record.session_id,
                        record.operator.casefold(),
                        record.started_at,
                        record.ended_at,
                        record.direction,
                        record.counterparty,
                        json.dumps(record.turns, ensure_ascii=False),
                        json.dumps(record.stats, ensure_ascii=False),
                        record.summary,
                        json.dumps(record.action_items, ensure_ascii=False),
                    ),
                )

        async with self._lock:
            await asyncio.to_thread(write)

    async def set_summary(self, call_id: str, summary: str, action_items: Sequence[str]) -> None:
        def write() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE calls SET summary = ?, action_items = ? WHERE id = ?",
                    (summary, json.dumps(list(action_items), ensure_ascii=False), call_id),
                )

        async with self._lock:
            await asyncio.to_thread(write)

    async def recent(self, operator: str | None, limit: int = 50) -> list[CallRecord]:
        """``operator`` None means every call — reserved for admins."""

        def read() -> list[CallRecord]:
            with self._connect() as conn:
                if operator is None:
                    rows = conn.execute(
                        "SELECT * FROM calls ORDER BY started_at DESC LIMIT ?", (limit,)
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM calls WHERE operator = ? ORDER BY started_at DESC LIMIT ?",
                        (operator.casefold(), limit),
                    ).fetchall()
            return [_record(row) for row in rows]

        return await asyncio.to_thread(read)

    async def get(self, call_id: str) -> CallRecord | None:
        def read() -> CallRecord | None:
            with self._connect() as conn:
                row = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            return None if row is None else _record(row)

        return await asyncio.to_thread(read)

    async def prune(self, older_than_days: float, now: float | None = None) -> int:
        """Delete transcripts past their retention window (SPEC A9).

        Recordings of real customer conversations are not kept indefinitely
        because nobody got round to deleting them.
        """
        cutoff = (time.time() if now is None else now) - older_than_days * 86400.0

        def write() -> int:
            with self._connect() as conn:
                cursor = conn.execute("DELETE FROM calls WHERE started_at < ?", (cutoff,))
                return cursor.rowcount

        async with self._lock:
            return await asyncio.to_thread(write)


def _record(row: sqlite3.Row) -> CallRecord:
    return CallRecord(
        id=row["id"],
        session_id=row["session_id"],
        operator=row["operator"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        direction=row["direction"],
        counterparty=row["counterparty"],
        turns=json.loads(row["turns"]),
        stats=json.loads(row["stats"]),
        summary=row["summary"],
        action_items=json.loads(row["action_items"]),
    )
