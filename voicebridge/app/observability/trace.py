"""Per-call trace (SPEC §7).

Keeps the last call's events in memory and turns them into the per-stage
waterfall the spec asks for, so latency questions are answered by opening a
URL instead of reading a terminal. Memory only, one call deep: durable
storage is M2's Postgres work.
"""

import statistics
from dataclasses import dataclass, field
from typing import Any

from app.observability.events import Event

MAX_EVENTS = 5000


@dataclass(frozen=True, slots=True)
class Utterance:
    correlation_id: str
    direction: str | None
    trigger: str | None
    source_text: str
    translated_text: str
    commit_to_audio_ms: float | None
    mt_ms: float | None
    tts_ms: float | None
    interrupted: bool


@dataclass(slots=True)
class CallTrace:
    """EventSink that remembers one call."""

    session_id: str = ""
    events: list[Event] = field(default_factory=list)

    def emit(self, event: Event) -> None:
        # Reset on the session ID, not on ``call_started``: a call that dies
        # during setup never reaches that event, and its errors must not be
        # filed under the previous call.
        if event.session_id != self.session_id:
            self.session_id = event.session_id
            self.events = []
        if len(self.events) < MAX_EVENTS:
            self.events.append(event)

    # --- analysis -----------------------------------------------------------

    def utterances(self) -> list[Utterance]:
        by_correlation: dict[str, list[Event]] = {}
        for event in self.events:
            if event.correlation_id is None:
                continue
            by_correlation.setdefault(event.correlation_id, []).append(event)

        out: list[Utterance] = []
        for correlation_id, group in by_correlation.items():
            at = {event.name: event.monotonic_ts for event in group}
            payloads = {event.name: dict(event.payload) for event in group}
            committed = at.get("segment_committed")
            out.append(
                Utterance(
                    correlation_id=correlation_id,
                    direction=group[0].direction,
                    trigger=_text(payloads.get("segment_committed", {}).get("trigger")),
                    source_text=_text(payloads.get("mt_completed", {}).get("source_text"))
                    or _text(payloads.get("segment_committed", {}).get("text")),
                    translated_text=_text(payloads.get("mt_completed", {}).get("translated_text")),
                    commit_to_audio_ms=_delta(committed, at.get("tts_first_audio")),
                    mt_ms=_delta(at.get("mt_started"), at.get("mt_completed")),
                    tts_ms=_delta(at.get("tts_started"), at.get("tts_first_audio")),
                    interrupted="tts_cancelled" in at,
                )
            )
        out.sort(key=lambda u: u.commit_to_audio_ms is None)
        return out

    def summary(self) -> dict[str, Any]:
        utterances = self.utterances()
        delivered = [u.commit_to_audio_ms for u in utterances if u.commit_to_audio_ms is not None]
        errors = [dict(e.payload) | {"name": e.name} for e in self.events if e.name == "error"]
        return {
            "session_id": self.session_id,
            "events": len(self.events),
            "utterances": len(utterances),
            "delivered_to_audio": len(delivered),
            "commit_to_first_audio_ms": {
                "p50": _round(statistics.median(delivered)) if delivered else None,
                "p95": _round(_percentile(delivered, 0.95)) if delivered else None,
                "max": _round(max(delivered)) if delivered else None,
            },
            "barge_ins": sum(1 for e in self.events if e.name == "barge_in"),
            "queue_drops": sum(1 for e in self.events if e.name == "queue_dropped"),
            "errors": errors,
            "turns": [
                {
                    "direction": u.direction,
                    "trigger": u.trigger,
                    "source": u.source_text,
                    "translated": u.translated_text,
                    "commit_to_audio_ms": _round(u.commit_to_audio_ms),
                    "mt_ms": _round(u.mt_ms),
                    "tts_ms": _round(u.tts_ms),
                    "interrupted": u.interrupted,
                }
                for u in utterances
            ],
        }


def _text(value: object) -> str:
    return "" if value is None else str(value)


def _delta(start: float | None, end: float | None) -> float | None:
    if start is None or end is None:
        return None
    return end - start


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 1)


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = max(0, round(fraction * len(ordered)) - 1)
    return ordered[index]
