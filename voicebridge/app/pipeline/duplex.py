"""Duplex controller (ADR-006).

The only component allowed to start or stop TTS playback. One instance per
session owns both directions, because barge-in is inherently a cross-direction
concern: a human speaking on one side must silence the TTS playing *to* that
side, which belongs to the opposite direction's pipeline.
"""

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum

from app.audio.frames import AudioFrame
from app.config import DuplexConfig
from app.observability.events import EventBus, monotonic_ms
from app.providers.base import Synthesis
from app.types import Direction, Side, source_side, target_side

DIRECTIONS: tuple[Direction, Direction] = ("a2b", "b2a")


class DirectionState(StrEnum):
    IDLE = "idle"
    LISTENING = "listening"
    TRANSLATING = "translating"
    SPEAKING = "speaking"


@dataclass(slots=True)
class Utterance:
    """One translated utterance ready for playback. ``cancel`` aborts the
    in-flight vendor synthesis (must complete in <50 ms, ADR-006)."""

    correlation_id: str
    text: str
    synthesis: Synthesis
    cancel: Callable[[], Awaitable[None]]


@dataclass(slots=True)
class _Queued:
    utterance: Utterance
    enqueued_at_ms: float


@dataclass(slots=True)
class _Active:
    utterance: Utterance
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)


class DuplexController:
    def __init__(
        self,
        *,
        config: DuplexConfig,
        events: EventBus,
        send_frame: Callable[[Direction, AudioFrame], Awaitable[None]],
        flush: Callable[[Direction], Awaitable[None]],
        clock: Callable[[], float] = monotonic_ms,
    ) -> None:
        self._cfg = config
        self._events = events
        self._send_frame = send_frame
        self._flush = flush
        self._clock = clock
        self._queues: dict[Direction, deque[_Queued]] = {d: deque() for d in DIRECTIONS}
        self._wake: dict[Direction, asyncio.Event] = {d: asyncio.Event() for d in DIRECTIONS}
        self._state: dict[Direction, DirectionState] = dict.fromkeys(
            DIRECTIONS, DirectionState.IDLE
        )
        self._active: dict[Direction, _Active | None] = dict.fromkeys(DIRECTIONS)
        self._human_speaking: dict[Side, bool] = {"caller": False, "operator": False}
        self._closed = False

    # --- lifecycle ----------------------------------------------------------

    def start(self, tg: asyncio.TaskGroup) -> None:
        for direction in DIRECTIONS:
            tg.create_task(self._worker(direction))

    def close(self) -> None:
        self._closed = True
        for direction in DIRECTIONS:
            self._wake[direction].set()

    # --- observational state (console / metrics) ----------------------------

    def state(self, direction: Direction) -> DirectionState:
        return self._state[direction]

    def note_translating(self, direction: Direction) -> None:
        if self._state[direction] is not DirectionState.SPEAKING:
            self._state[direction] = DirectionState.TRANSLATING

    # --- inputs -------------------------------------------------------------

    async def submit(self, direction: Direction, utterance: Utterance) -> None:
        self._queues[direction].append(_Queued(utterance, self._clock()))
        self._wake[direction].set()

    async def on_vad_onset(self, side: Side) -> None:
        self._human_speaking[side] = True
        for direction in DIRECTIONS:
            if source_side(direction) == side and self._state[direction] is DirectionState.IDLE:
                self._state[direction] = DirectionState.LISTENING
        for direction in DIRECTIONS:
            if target_side(direction) != side:
                continue
            active = self._active[direction]
            if active is None or active.cancelled.is_set():
                continue
            # Barge-in budget (300 ms): flag stops our frame loop on the next
            # iteration, vendor cancel stops synthesis, flush drops whatever
            # the telephony layer already buffered.
            active.cancelled.set()
            await active.utterance.cancel()
            await self._flush(direction)
            self._events.emit(
                "barge_in",
                direction=direction,
                correlation_id=active.utterance.correlation_id,
            )

    async def on_vad_offset(self, side: Side) -> None:
        self._human_speaking[side] = False
        for direction in DIRECTIONS:
            if source_side(direction) == side and self._state[direction] is DirectionState.LISTENING:
                self._state[direction] = DirectionState.IDLE
            if target_side(direction) == side:
                self._wake[direction].set()

    # --- playback -----------------------------------------------------------

    async def _worker(self, direction: Direction) -> None:
        queue = self._queues[direction]
        wake = self._wake[direction]
        while True:
            await wake.wait()
            wake.clear()
            if self._closed:
                return
            while queue and not self._human_speaking[target_side(direction)]:
                queued = queue.popleft()
                age_ms = self._clock() - queued.enqueued_at_ms
                if age_ms > self._cfg.max_queue_ms:
                    # Stale translation is worse than missing translation.
                    self._events.emit(
                        "queue_dropped",
                        direction=direction,
                        correlation_id=queued.utterance.correlation_id,
                        age_ms=age_ms,
                    )
                    continue
                await self._play(direction, queued.utterance)
            if self._closed:
                return

    async def _play(self, direction: Direction, utterance: Utterance) -> None:
        active = _Active(utterance=utterance)
        self._active[direction] = active
        self._state[direction] = DirectionState.SPEAKING
        first = True
        frames_sent = 0
        try:
            async for frame in utterance.synthesis.frames:
                if active.cancelled.is_set():
                    break
                await self._send_frame(direction, frame)
                frames_sent += 1
                if first:
                    first = False
                    self._events.emit(
                        "tts_first_audio",
                        direction=direction,
                        correlation_id=utterance.correlation_id,
                    )
        finally:
            self._active[direction] = None
            self._state[direction] = DirectionState.IDLE
        if active.cancelled.is_set():
            # The un-played remainder goes to the transcript as interrupted.
            self._events.emit(
                "tts_cancelled",
                direction=direction,
                correlation_id=utterance.correlation_id,
                interrupted=True,
                frames_sent=frames_sent,
                text=utterance.text,
            )
        else:
            self._events.emit(
                "tts_completed",
                direction=direction,
                correlation_id=utterance.correlation_id,
                frames_sent=frames_sent,
            )
