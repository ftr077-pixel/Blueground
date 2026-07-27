"""Session event stream (SPEC.md §6.5).

Every stage boundary emits exactly one of these events. The correlation ID is
assigned at ``segment_committed`` and threaded through every downstream event
for the same utterance — it is what makes per-stage latency analysis possible.
"""

import json
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol, TextIO

from app.types import Direction

EventName = Literal[
    "call_started",
    "leg_connected",
    "speech_start",
    "asr_partial",
    "asr_final",
    "segment_committed",
    "mt_started",
    "mt_completed",
    "tts_started",
    "tts_first_audio",
    "tts_completed",
    "tts_cancelled",
    "barge_in",
    "queue_dropped",
    "error",
    "call_ended",
]

_FORBIDDEN_PAYLOAD_TYPES = (bytes, bytearray, memoryview)


@dataclass(frozen=True, slots=True)
class Event:
    name: EventName
    session_id: str
    monotonic_ts: float
    wall_ts: float
    direction: Direction | None = None
    correlation_id: str | None = None
    payload: Mapping[str, object] = field(default_factory=dict)

    def to_json(self) -> str:
        record: dict[str, object] = {
            "name": self.name,
            "session_id": self.session_id,
            "direction": self.direction,
            "monotonic_ts": self.monotonic_ts,
            "wall_ts": self.wall_ts,
            "correlation_id": self.correlation_id,
            **self.payload,
        }
        return json.dumps(record, ensure_ascii=False)


class EventSink(Protocol):
    def emit(self, event: Event) -> None: ...


def monotonic_ms() -> float:
    return time.monotonic() * 1000.0


class EventBus:
    """Fans events out to sinks. Emission is synchronous and must stay cheap —
    it runs in the media hot path."""

    def __init__(self, session_id: str, sinks: tuple[EventSink, ...]) -> None:
        self._session_id = session_id
        self._sinks = sinks

    def emit(
        self,
        name: EventName,
        *,
        direction: Direction | None = None,
        correlation_id: str | None = None,
        **payload: object,
    ) -> Event:
        for value in payload.values():
            # Audio payloads in logs are forbidden (§7). Fail loudly, not silently.
            if isinstance(value, _FORBIDDEN_PAYLOAD_TYPES):
                raise TypeError(f"raw byte payload in event {name!r} — log counts, not audio")
        event = Event(
            name=name,
            session_id=self._session_id,
            monotonic_ts=monotonic_ms(),
            wall_ts=time.time(),
            direction=direction,
            correlation_id=correlation_id,
            payload=payload,
        )
        for sink in self._sinks:
            sink.emit(event)
        return event


class EventRecorder:
    """In-memory sink for tests and the simulator."""

    def __init__(self) -> None:
        self.events: list[Event] = []

    def emit(self, event: Event) -> None:
        self.events.append(event)

    def named(self, name: EventName) -> list[Event]:
        return [e for e in self.events if e.name == name]

    def for_correlation(self, correlation_id: str) -> list[Event]:
        return [e for e in self.events if e.correlation_id == correlation_id]

    def names(self) -> Iterator[EventName]:
        return (e.name for e in self.events)


class JsonLinesSink:
    """Structured JSON logs, one line per event (§7)."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def emit(self, event: Event) -> None:
        self._stream.write(event.to_json() + "\n")
