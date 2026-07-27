"""Telephony adapter conformance suite (SPEC.md §6.1).

Every ``TelephonyAdapter`` implementation — Fake today, Twilio at M0, LiveKit
at M3 — must pass this same suite. Subclass it and implement ``make``; the
controls let the suite drive the far end of the wire without knowing the
transport.

Audio assertions are energy-based, not byte-exact: a real adapter's wire
format is lossy (mu-law, resampling), so the contract is "internal format,
right duration, speech stays speech and silence stays silence" — not bit
identity.
"""

import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.telephony.base import CallContext, CallLegs, Leg, TelephonyAdapter

CTX = CallContext(session_id="conf", caller_language="he", operator_language="en")

TONE_AMPLITUDE = 6000
SPEECH_RMS_FLOOR = 1000.0
SILENCE_RMS_CEILING = 100.0


def tone_frame(ts_ms: float, samples: int = 320) -> AudioFrame:
    """20 ms of 400 Hz tone at 16 kHz — survives any sane telephony codec."""
    pcm = bytearray()
    for n in range(samples):
        v = int(TONE_AMPLITUDE * math.sin(2 * math.pi * 400.0 * n / INTERNAL_SAMPLE_RATE))
        pcm += v.to_bytes(2, "little", signed=True)
    return AudioFrame(pcm=bytes(pcm), sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=ts_ms)


def quiet_frame(ts_ms: float, samples: int = 320) -> AudioFrame:
    return AudioFrame(pcm=b"\x00\x00" * samples, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=ts_ms)


def rms(pcm: bytes) -> float:
    if not pcm:
        return 0.0
    total = 0
    count = len(pcm) // 2
    for i in range(0, len(pcm), 2):
        v = int.from_bytes(pcm[i : i + 2], "little", signed=True)
        total += v * v
    return math.sqrt(total / count)


def _segment_rms(frames: list[AudioFrame], begin_ms: float, end_ms: float) -> float:
    """RMS of the received stream between two positions, trimming 10 ms at
    each edge to stay clear of codec/resampler transition ripple."""
    pcm = b"".join(f.pcm for f in frames)
    bytes_per_ms = INTERNAL_SAMPLE_RATE * 2 / 1000.0
    lo = int((begin_ms + 10.0) * bytes_per_ms) & ~1
    hi = int((end_ms - 10.0) * bytes_per_ms) & ~1
    return rms(pcm[lo:hi])


@dataclass(slots=True)
class AdapterControls:
    """Test-side hooks onto the far end of the adapter's wire.

    ``feed``/``sent_frames`` speak internal format (16 kHz PCM16); the harness
    for a real adapter owns the wire-side transcoding in both directions.
    """

    feed: Callable[[Leg, AudioFrame], Awaitable[None]]
    end_inbound: Callable[[Leg], Awaitable[None]]
    sent_frames: Callable[[Leg], list[AudioFrame]]
    flush_count: Callable[[Leg], int]


class TelephonyAdapterConformance:
    async def make(self) -> tuple[TelephonyAdapter, AdapterControls]:
        raise NotImplementedError

    async def _call(self) -> tuple[TelephonyAdapter, AdapterControls, CallLegs]:
        adapter, controls = await self.make()
        legs = await adapter.accept_call(CTX)
        return adapter, controls, legs

    async def test_accept_call_returns_both_sides(self) -> None:
        _, _, legs = await self._call()
        assert legs.caller.side == "caller"
        assert legs.operator.side == "operator"
        assert legs.caller.id != legs.operator.id

    async def test_inbound_is_internal_format_with_pattern_preserved(self) -> None:
        adapter, controls, legs = await self._call()
        # 100 ms tone, 100 ms silence, 100 ms tone.
        ts = 0.0
        for block in (tone_frame, quiet_frame, tone_frame):
            for _ in range(5):
                await controls.feed(legs.caller, block(ts))
                ts += 20.0
        await controls.end_inbound(legs.caller)
        received = [frame async for frame in adapter.inbound_audio(legs.caller)]
        assert received != []
        assert all(f.sample_rate == INTERNAL_SAMPLE_RATE for f in received)
        total_ms = sum(f.duration_ms for f in received)
        # Lower bound leaves room for resampler group delay in a lossy
        # harness chain; upper bound catches duplication.
        assert 260.0 <= total_ms <= 310.0
        assert _segment_rms(received, 0.0, 100.0) > SPEECH_RMS_FLOOR
        assert _segment_rms(received, 100.0, 200.0) < SILENCE_RMS_CEILING
        assert _segment_rms(received, 200.0, 300.0) > SPEECH_RMS_FLOOR

    async def test_inbound_legs_are_independent(self) -> None:
        adapter, controls, legs = await self._call()
        await controls.feed(legs.operator, tone_frame(0.0))
        await controls.end_inbound(legs.caller)
        await controls.end_inbound(legs.operator)
        caller_frames = [f async for f in adapter.inbound_audio(legs.caller)]
        operator_frames = [f async for f in adapter.inbound_audio(legs.operator)]
        assert caller_frames == []
        assert sum(f.duration_ms for f in operator_frames) > 0.0

    async def test_send_audio_reaches_only_the_addressed_leg(self) -> None:
        adapter, controls, legs = await self._call()
        ts = 0.0
        for _ in range(5):
            await adapter.send_audio(legs.operator, tone_frame(ts))
            ts += 20.0
        sent = controls.sent_frames(legs.operator)
        assert sent != []
        total_ms = sum(f.duration_ms for f in sent)
        assert 60.0 <= total_ms <= 110.0
        assert _segment_rms(sent, 0.0, total_ms) > SPEECH_RMS_FLOOR
        assert controls.sent_frames(legs.caller) == []

    async def test_flush_outbound_is_per_leg(self) -> None:
        adapter, controls, legs = await self._call()
        await adapter.flush_outbound(legs.operator)
        assert controls.flush_count(legs.operator) == 1
        assert controls.flush_count(legs.caller) == 0
