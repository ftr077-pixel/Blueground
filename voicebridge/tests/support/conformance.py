"""Telephony adapter conformance suite (SPEC.md §6.1).

Every ``TelephonyAdapter`` implementation — Fake today, Twilio at M0, LiveKit
at M3 — must pass this same suite. Subclass it and implement ``make``; the
controls let the suite drive the far end of the wire without knowing the
transport.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.telephony.base import CallContext, CallLegs, Leg, TelephonyAdapter
from tests.support.fakes import silence_frame, speech_frame

CTX = CallContext(session_id="conf", caller_language="he", operator_language="en")


@dataclass(slots=True)
class AdapterControls:
    """Test-side hooks onto the far end of the adapter's wire."""

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

    async def test_inbound_frames_arrive_in_order_as_internal_format(self) -> None:
        adapter, controls, legs = await self._call()
        fed = [speech_frame(0.0), silence_frame(20.0), speech_frame(40.0)]
        for frame in fed:
            await controls.feed(legs.caller, frame)
        await controls.end_inbound(legs.caller)
        received = [frame async for frame in adapter.inbound_audio(legs.caller)]
        assert [f.pcm for f in received] == [f.pcm for f in fed]
        assert all(f.sample_rate == INTERNAL_SAMPLE_RATE for f in received)

    async def test_inbound_legs_are_independent(self) -> None:
        adapter, controls, legs = await self._call()
        await controls.feed(legs.operator, speech_frame(0.0))
        await controls.end_inbound(legs.caller)
        await controls.end_inbound(legs.operator)
        caller_frames = [f async for f in adapter.inbound_audio(legs.caller)]
        operator_frames = [f async for f in adapter.inbound_audio(legs.operator)]
        assert caller_frames == []
        assert len(operator_frames) == 1

    async def test_send_audio_reaches_only_the_addressed_leg(self) -> None:
        adapter, controls, legs = await self._call()
        frame = speech_frame(0.0)
        await adapter.send_audio(legs.operator, frame)
        assert [f.pcm for f in controls.sent_frames(legs.operator)] == [frame.pcm]
        assert controls.sent_frames(legs.caller) == []

    async def test_flush_outbound_is_per_leg(self) -> None:
        adapter, controls, legs = await self._call()
        await adapter.flush_outbound(legs.operator)
        assert controls.flush_count(legs.operator) == 1
        assert controls.flush_count(legs.caller) == 0
