"""Telephony contract (SPEC.md §6.1) — the one abstraction we have already
committed to replacing (ADR-001: Twilio at M0, LiveKit at M3).

Adapters own all wire-format transcoding: everything crossing this boundary is
16 kHz mono PCM16 (ADR-002).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from app.audio.frames import AudioFrame
from app.types import Side


@dataclass(frozen=True, slots=True)
class CallContext:
    session_id: str
    caller_language: str
    operator_language: str


@dataclass(frozen=True, slots=True)
class Leg:
    id: str
    side: Side


@dataclass(frozen=True, slots=True)
class CallLegs:
    caller: Leg
    operator: Leg


class TelephonyAdapter(Protocol):
    async def accept_call(self, ctx: CallContext) -> CallLegs:
        """Establish both legs. Returns handles for caller and operator."""
        ...

    def inbound_audio(self, leg: Leg) -> AsyncIterator[AudioFrame]:
        """Yield 20 ms frames of 16 kHz mono PCM16. Adapter owns transcoding."""
        ...

    async def send_audio(self, leg: Leg, frame: AudioFrame) -> None:
        """Inject one frame. Adapter owns transcoding to wire format."""
        ...

    async def flush_outbound(self, leg: Leg) -> None:
        """Discard queued outbound audio. Used for barge-in."""
        ...

    async def hangup(self, leg: Leg) -> None: ...
