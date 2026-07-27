"""TwilioAdapter tests: Media Streams protocol handling over an injected
transport, wire-format transcoding in both directions, and the §6.1
conformance suite run through a lossy mu-law/8 kHz harness."""

import asyncio
import base64
import json
import math

import pytest

from app.audio.codecs import mulaw_decode, mulaw_encode
from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.audio.resample import StreamResampler
from app.telephony.base import CallContext, Leg, TelephonyAdapter
from app.telephony.twilio import TWILIO_SAMPLE_RATE, TwilioAdapter, TwilioHandshakeError
from tests.support.conformance import (
    AdapterControls,
    TelephonyAdapterConformance,
    rms,
    tone_frame,
)

CTX = CallContext(session_id="tw", caller_language="he", operator_language="en")
SID = "MZ1234567890"


class FakeMessageStream:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False

    async def recv(self) -> str | bytes | None:
        return await self.incoming.get()

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True


def start_message(sid: str = SID) -> str:
    return json.dumps({"event": "start", "streamSid": sid, "start": {"streamSid": sid}})


def media_message(pcm8k: bytes, track: str = "inbound") -> str:
    payload = base64.b64encode(mulaw_encode(pcm8k)).decode("ascii")
    return json.dumps({"event": "media", "media": {"track": track, "payload": payload}})


def tone_8k(samples: int) -> bytes:
    pcm = bytearray()
    for n in range(samples):
        v = int(6000 * math.sin(2 * math.pi * 400.0 * n / TWILIO_SAMPLE_RATE))
        pcm += v.to_bytes(2, "little", signed=True)
    return bytes(pcm)


async def connected_adapter() -> tuple[TwilioAdapter, FakeMessageStream, FakeMessageStream]:
    caller_ws = FakeMessageStream()
    operator_ws = FakeMessageStream()
    await caller_ws.incoming.put(json.dumps({"event": "connected"}))
    await caller_ws.incoming.put(start_message())
    adapter = TwilioAdapter(caller_ws, operator_ws)
    return adapter, caller_ws, operator_ws


async def test_accept_call_waits_for_start_and_captures_stream_sid() -> None:
    adapter, caller_ws, _ = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    assert legs.caller.side == "caller"
    await adapter.flush_outbound(legs.caller)
    cleared = json.loads(str(caller_ws.sent[-1]))
    assert cleared == {"event": "clear", "streamSid": SID}


async def test_close_before_start_raises() -> None:
    caller_ws = FakeMessageStream()
    await caller_ws.incoming.put(None)
    adapter = TwilioAdapter(caller_ws, FakeMessageStream())
    with pytest.raises(TwilioHandshakeError):
        await adapter.accept_call(CTX)


async def test_caller_inbound_transcodes_mulaw_8k_to_internal() -> None:
    adapter, caller_ws, _ = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    fed_samples = 0
    for _ in range(10):
        chunk = tone_8k(160)  # 20 ms at 8 kHz
        fed_samples += 160
        await caller_ws.incoming.put(media_message(chunk))
    await caller_ws.incoming.put(json.dumps({"event": "stop"}))
    received = [f async for f in adapter.inbound_audio(legs.caller)]
    assert received != []
    assert all(f.sample_rate == INTERNAL_SAMPLE_RATE for f in received)
    got_samples = sum(f.samples for f in received)
    # The FIR holds its group delay (~2 ms = 62 samples at 16 kHz).
    assert fed_samples * 2 - 128 <= got_samples <= fed_samples * 2 + 16
    assert rms(b"".join(f.pcm for f in received)) > 1000.0


async def test_outbound_track_is_never_yielded() -> None:
    adapter, caller_ws, _ = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    await caller_ws.incoming.put(media_message(tone_8k(160), track="outbound"))
    await caller_ws.incoming.put(json.dumps({"event": "stop"}))
    received = [f async for f in adapter.inbound_audio(legs.caller)]
    assert received == []


async def test_send_audio_to_caller_emits_mulaw_media_messages() -> None:
    adapter, caller_ws, _ = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    sent_samples_16k = 0
    for i in range(10):
        frame = tone_frame(i * 20.0)
        sent_samples_16k += frame.samples
        await adapter.send_audio(legs.caller, frame)
    payload_bytes = b""
    for raw in caller_ws.sent:
        message = json.loads(str(raw))
        assert message["event"] == "media"
        assert message["streamSid"] == SID
        payload_bytes += base64.b64decode(message["media"]["payload"])
    # mu-law is one byte per 8 kHz sample: expect ~half the 16 kHz count,
    # minus the FIR's ~2 ms held group delay.
    assert sent_samples_16k // 2 - 128 <= len(payload_bytes) <= sent_samples_16k // 2 + 16
    assert rms(mulaw_decode(payload_bytes)) > 1000.0


async def test_send_audio_rejects_non_internal_rate() -> None:
    adapter, _, _ = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    bad = AudioFrame(pcm=b"\x00\x00" * 160, sample_rate=8000, ts_ms=0.0)
    with pytest.raises(ValueError, match="internal format"):
        await adapter.send_audio(legs.caller, bad)


async def test_operator_leg_is_binary_passthrough_and_ignores_text() -> None:
    adapter, _, operator_ws = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    frame = tone_frame(0.0)
    await adapter.send_audio(legs.operator, frame)
    assert operator_ws.sent == [frame.pcm]
    await operator_ws.incoming.put("not audio")
    await operator_ws.incoming.put(frame.pcm)
    await operator_ws.incoming.put(None)
    received = [f async for f in adapter.inbound_audio(legs.operator)]
    assert [f.pcm for f in received] == [frame.pcm]
    await adapter.flush_outbound(legs.operator)
    assert json.loads(str(operator_ws.sent[-1])) == {"event": "clear"}


async def test_hangup_closes_the_right_socket() -> None:
    adapter, caller_ws, operator_ws = await connected_adapter()
    legs = await adapter.accept_call(CTX)
    await adapter.hangup(legs.caller)
    assert caller_ws.closed and not operator_ws.closed


class TwilioHarness:
    """Drives the far end of both wires in wire format, exposing internal
    format to the conformance suite."""

    def __init__(self, caller_ws: FakeMessageStream, operator_ws: FakeMessageStream) -> None:
        self.caller_ws = caller_ws
        self.operator_ws = operator_ws
        self._feed_resampler = StreamResampler(INTERNAL_SAMPLE_RATE, TWILIO_SAMPLE_RATE)
        self._sent_resampler = StreamResampler(TWILIO_SAMPLE_RATE, INTERNAL_SAMPLE_RATE)
        self._sent_parsed = 0
        self._sent_cache: list[AudioFrame] = []
        self._caller_flushes = 0

    async def feed(self, leg: Leg, frame: AudioFrame) -> None:
        if leg.side == "operator":
            await self.operator_ws.incoming.put(frame.pcm)
            return
        pcm8k = self._feed_resampler.process(frame.pcm)
        if pcm8k:
            await self.caller_ws.incoming.put(media_message(pcm8k))

    async def end_inbound(self, leg: Leg) -> None:
        if leg.side == "caller":
            await self.caller_ws.incoming.put(json.dumps({"event": "stop"}))
        else:
            await self.operator_ws.incoming.put(None)

    def sent_frames(self, leg: Leg) -> list[AudioFrame]:
        if leg.side == "operator":
            return [
                AudioFrame(pcm=raw, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=0.0)
                for raw in self.operator_ws.sent
                if isinstance(raw, bytes)
            ]
        # Parse incrementally: the internal-rate resampler is stateful, so
        # each wire message must be decoded exactly once.
        for raw in self.caller_ws.sent[self._sent_parsed :]:
            self._sent_parsed += 1
            message = json.loads(str(raw))
            if message["event"] == "clear":
                self._caller_flushes += 1
                continue
            pcm8k = mulaw_decode(base64.b64decode(message["media"]["payload"]))
            pcm16k = self._sent_resampler.process(pcm8k)
            if pcm16k:
                self._sent_cache.append(
                    AudioFrame(pcm=pcm16k, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=0.0)
                )
        return list(self._sent_cache)

    def flush_count(self, leg: Leg) -> int:
        if leg.side == "operator":
            return sum(
                1
                for raw in self.operator_ws.sent
                if isinstance(raw, str) and json.loads(raw) == {"event": "clear"}
            )
        self.sent_frames(leg)  # advance the parser
        return self._caller_flushes


class TestTwilioAdapterConformance(TelephonyAdapterConformance):
    async def make(self) -> tuple[TelephonyAdapter, AdapterControls]:
        adapter, caller_ws, operator_ws = await connected_adapter()
        harness = TwilioHarness(caller_ws, operator_ws)
        return adapter, AdapterControls(
            feed=harness.feed,
            end_inbound=harness.end_inbound,
            sent_frames=harness.sent_frames,
            flush_count=harness.flush_count,
        )
