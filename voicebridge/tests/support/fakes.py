"""Offline fakes implementing the §6 contracts.

Fake TTS frames carry a content marker derived from the synthesized text, so
tests can prove that synthesized audio never reaches an ASR input (the ADR-006
feedback-loop guard) by inspecting bytes, not by trusting wiring.
"""

import asyncio
import hashlib
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.audio.vad import VadFrameResult
from app.observability.events import monotonic_ms
from app.providers.base import (
    ASROptions,
    ASRResult,
    Glossary,
    Synthesis,
    SynthesisHandle,
    Tier,
    Translation,
    Translator,
    Turn,
    VoiceSpec,
)
from app.telephony.base import CallContext, CallLegs, Leg

MARKER_LEN = 16
FRAME_SAMPLES_20MS = INTERNAL_SAMPLE_RATE // 50


def tts_marker(text: str) -> bytes:
    return hashlib.sha256(("tts:" + text).encode()).digest()[:MARKER_LEN]


def marker_of(frame: AudioFrame) -> bytes:
    return frame.pcm[:MARKER_LEN]


def speech_frame(ts_ms: float) -> AudioFrame:
    """A 20 ms frame the energy VAD treats as speech."""
    return AudioFrame(pcm=b"\x40\x00" * FRAME_SAMPLES_20MS, sample_rate=16_000, ts_ms=ts_ms)


def silence_frame(ts_ms: float) -> AudioFrame:
    return AudioFrame(pcm=b"\x00\x00" * FRAME_SAMPLES_20MS, sample_rate=16_000, ts_ms=ts_ms)


class EnergyVad:
    """Deterministic stand-in for Silero: nonzero PCM is speech."""

    def __init__(self) -> None:
        self._speaking = False
        self._silence_ms = 0.0

    def process(self, frame: AudioFrame) -> VadFrameResult:
        is_speech = any(frame.pcm)
        onset = is_speech and not self._speaking
        self._speaking = is_speech
        if is_speech:
            self._silence_ms = 0.0
        else:
            self._silence_ms += frame.duration_ms
        return VadFrameResult(is_speech=is_speech, onset=onset, silence_ms=self._silence_ms)

    def reset(self) -> None:
        self._speaking = False
        self._silence_ms = 0.0


class FakeTTS:
    """Streaming, cancellable TTS. Frames carry ``tts_marker(text)``."""

    def __init__(
        self,
        *,
        ttfa_ms: float = 10.0,
        frame_count: int = 5,
        frame_interval_ms: float = 5.0,
    ) -> None:
        self.ttfa_ms = ttfa_ms
        self.frame_count = frame_count
        self.frame_interval_ms = frame_interval_ms
        self.synthesized: list[str] = []
        self.cancelled: list[SynthesisHandle] = []
        self._cancel_flags: dict[str, asyncio.Event] = {}

    def synthesize(self, text: str, voice: VoiceSpec) -> Synthesis:
        self.synthesized.append(text)
        handle = SynthesisHandle(id=uuid.uuid4().hex)
        flag = asyncio.Event()
        self._cancel_flags[handle.id] = flag
        return Synthesis(handle=handle, frames=self._stream(text, flag))

    async def _stream(self, text: str, flag: asyncio.Event) -> AsyncIterator[AudioFrame]:
        await asyncio.sleep(self.ttfa_ms / 1000.0)
        marker = tts_marker(text)
        padding = b"\x01\x00" * FRAME_SAMPLES_20MS
        pcm = (marker + padding)[: FRAME_SAMPLES_20MS * 2]
        for _ in range(self.frame_count):
            if flag.is_set():
                return
            yield AudioFrame(pcm=pcm, sample_rate=16_000, ts_ms=monotonic_ms())
            await asyncio.sleep(self.frame_interval_ms / 1000.0)

    async def cancel(self, handle: SynthesisHandle) -> None:
        self.cancelled.append(handle)
        self._cancel_flags[handle.id].set()


class DictTranslator(Translator):
    """Phrase-table translator with configurable latency."""

    def __init__(self, table: dict[str, str], *, latency_ms: float = 20.0) -> None:
        self._table = table
        self._latency_ms = latency_ms
        self.calls: list[tuple[str, str, str, Tier]] = []

    async def translate(
        self,
        text: str,
        source: str,
        target: str,
        context: list[Turn],
        glossary: Glossary | None,
        tier: Tier,
    ) -> Translation:
        self.calls.append((text, source, target, tier))
        await asyncio.sleep(self._latency_ms / 1000.0)
        return Translation(text=self._table.get(text, f"[{target}] {text}"), tier=tier)


@dataclass(frozen=True, slots=True)
class ScriptedResult:
    at_ms: float
    """Emission time relative to ``open()``."""
    result: ASRResult


class ScriptedASR:
    """Replays a scripted result timeline on the wall clock; records every
    pushed frame so tests can prove what audio the ASR actually saw."""

    def __init__(self, script: list[ScriptedResult]) -> None:
        self._script = sorted(script, key=lambda s: s.at_ms)
        self._queue: asyncio.Queue[ASRResult | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self.pushed_frames: list[AudioFrame] = []
        self.language: str | None = None

    async def open(self, language: str, opts: ASROptions) -> None:
        self.language = language
        self._task = asyncio.create_task(self._replay())

    async def _replay(self) -> None:
        started = monotonic_ms()
        for entry in self._script:
            delay_ms = entry.at_ms - (monotonic_ms() - started)
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000.0)
            stamped = ASRResult(
                text=entry.result.text,
                is_final=entry.result.is_final,
                confidence=entry.result.confidence,
                words=entry.result.words,
                received_at=monotonic_ms(),
            )
            await self._queue.put(stamped)

    async def push(self, frame: AudioFrame) -> None:
        self.pushed_frames.append(frame)

    async def results(self) -> AsyncIterator[ASRResult]:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            yield item

    async def close(self) -> None:
        if self._task is not None:
            await self._task
            self._task = None
        await self._queue.put(None)


@dataclass(slots=True)
class _LegState:
    inbound: asyncio.Queue[AudioFrame | None] = field(default_factory=asyncio.Queue)
    sent: list[AudioFrame] = field(default_factory=list)
    flushes: int = 0


class FakeTelephonyAdapter:
    """In-memory adapter. Tests feed inbound frames per side and inspect what
    the gateway injected outbound."""

    def __init__(self) -> None:
        self._legs: dict[str, _LegState] = {}
        self.hangups: list[Leg] = []

    async def accept_call(self, ctx: CallContext) -> CallLegs:
        legs = CallLegs(
            caller=Leg(id=f"{ctx.session_id}-caller", side="caller"),
            operator=Leg(id=f"{ctx.session_id}-operator", side="operator"),
        )
        self._legs[legs.caller.id] = _LegState()
        self._legs[legs.operator.id] = _LegState()
        return legs

    async def inbound_audio(self, leg: Leg) -> AsyncIterator[AudioFrame]:
        state = self._legs[leg.id]
        while True:
            frame = await state.inbound.get()
            if frame is None:
                return
            yield frame

    async def send_audio(self, leg: Leg, frame: AudioFrame) -> None:
        self._legs[leg.id].sent.append(frame)

    async def flush_outbound(self, leg: Leg) -> None:
        self._legs[leg.id].flushes += 1

    async def hangup(self, leg: Leg) -> None:
        self.hangups.append(leg)

    # --- test-side controls -------------------------------------------------

    async def feed(self, leg: Leg, frame: AudioFrame) -> None:
        await self._legs[leg.id].inbound.put(frame)

    async def end_inbound(self, leg: Leg) -> None:
        await self._legs[leg.id].inbound.put(None)

    def sent_frames(self, leg: Leg) -> list[AudioFrame]:
        return self._legs[leg.id].sent

    def flush_count(self, leg: Leg) -> int:
        return self._legs[leg.id].flushes


async def wait_until(predicate: Callable[[], bool], timeout_s: float = 2.0) -> None:
    """Poll a zero-arg predicate until true; hard-fail after timeout."""
    deadline = monotonic_ms() + timeout_s * 1000.0
    while not predicate():
        if monotonic_ms() > deadline:
            raise AssertionError("wait_until predicate never became true")
        await asyncio.sleep(0.005)
