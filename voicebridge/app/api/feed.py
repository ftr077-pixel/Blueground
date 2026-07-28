"""Forward selected session events to the operator's socket as JSON.

M0 needs a way to see what the pipeline heard and said while a real call is
happening; the full console is M2. Emission stays off the media hot path: the
sink only appends to a queue, and a separate task does the sending.
"""

import asyncio
import contextlib

from app.observability.events import Event, EventName

FORWARDED: frozenset[EventName] = frozenset(
    {
        "asr_partial",
        "asr_final",
        "segment_committed",
        "mt_completed",
        "tts_first_audio",
        "tts_completed",
        "barge_in",
        "tts_cancelled",
        "error",
    }
)
MAX_PENDING = 256


class OperatorFeed:
    """EventSink that never blocks the pipeline: a full queue drops the
    oldest entry, because a stalled console must not stall a live call."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=MAX_PENDING)

    def emit(self, event: Event) -> None:
        if event.name not in FORWARDED:
            return
        line = event.to_json()
        try:
            self.queue.put_nowait(line)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                self.queue.put_nowait(line)

    def stop(self) -> None:
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)
