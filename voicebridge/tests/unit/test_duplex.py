"""ADR-006 duplex controller tests: barge-in, queueing behind a speaking
human, stale-drop, and ordering. Real asyncio, fake TTS and sinks."""

import asyncio
import functools
import uuid
from dataclasses import dataclass, field

from app.config import DuplexConfig
from app.observability.events import EventBus, EventRecorder, monotonic_ms
from app.pipeline.duplex import DirectionState, DuplexController, Utterance
from app.providers.base import VoiceSpec
from app.types import Direction

from tests.support.fakes import FakeTTS, marker_of, tts_marker, wait_until

VOICE = VoiceSpec(voice_id="test", language="en")


@dataclass
class Harness:
    recorder: EventRecorder
    controller: DuplexController
    sent: list[tuple[Direction, bytes]] = field(default_factory=list)
    flushed: list[Direction] = field(default_factory=list)


def make_harness(
    *, max_queue_ms: float = 3000.0, clock: object = None
) -> Harness:
    recorder = EventRecorder()
    bus = EventBus("session-test", (recorder,))
    harness_sent: list[tuple[Direction, bytes]] = []
    harness_flushed: list[Direction] = []

    async def send(direction: Direction, frame: object) -> None:
        from app.audio.frames import AudioFrame

        assert isinstance(frame, AudioFrame)
        harness_sent.append((direction, marker_of(frame)))

    async def flush(direction: Direction) -> None:
        harness_flushed.append(direction)

    controller = DuplexController(
        config=DuplexConfig(max_queue_ms=max_queue_ms),
        events=bus,
        send_frame=send,
        flush=flush,
        clock=clock if callable(clock) else monotonic_ms,  # type: ignore[arg-type]
    )
    harness = Harness(recorder=recorder, controller=controller)
    harness.sent = harness_sent
    harness.flushed = harness_flushed
    return harness


def utterance(tts: FakeTTS, text: str) -> Utterance:
    synthesis = tts.synthesize(text, VOICE)
    return Utterance(
        correlation_id=uuid.uuid4().hex,
        text=text,
        synthesis=synthesis,
        cancel=functools.partial(tts.cancel, synthesis.handle),
    )


async def test_plays_submitted_utterance_when_target_is_silent() -> None:
    h = make_harness()
    tts = FakeTTS(frame_count=3)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        await h.controller.submit("a2b", utterance(tts, "hello"))
        await wait_until(lambda: len(h.sent) == 3)
        h.controller.close()
    assert all(d == "a2b" and m == tts_marker("hello") for d, m in h.sent)
    names = [e.name for e in h.recorder.events]
    assert names.index("tts_first_audio") < names.index("tts_completed")
    assert h.controller.state("a2b") is DirectionState.IDLE


async def test_barge_in_cancels_playback_and_flushes() -> None:
    h = make_harness()
    tts = FakeTTS(frame_count=200, frame_interval_ms=10.0)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        await h.controller.submit("a2b", utterance(tts, "long sentence"))
        await wait_until(lambda: len(h.sent) >= 2)
        assert h.controller.state("a2b") is DirectionState.SPEAKING
        # The operator (target of a2b) starts talking mid-playback.
        await h.controller.on_vad_onset("operator")
        await wait_until(lambda: h.controller.state("a2b") is DirectionState.IDLE)
        frames_at_cancel = len(h.sent)
        await asyncio.sleep(0.05)
        assert len(h.sent) == frames_at_cancel
        h.controller.close()
    assert len(tts.cancelled) == 1
    assert h.flushed == ["a2b"]
    assert len(h.recorder.named("barge_in")) == 1
    cancelled = h.recorder.named("tts_cancelled")
    assert len(cancelled) == 1
    assert cancelled[0].payload["interrupted"] is True
    assert h.recorder.named("tts_completed") == []


async def test_never_plays_while_target_side_is_speaking() -> None:
    h = make_harness()
    tts = FakeTTS(frame_count=2)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        await h.controller.on_vad_onset("operator")
        await h.controller.submit("a2b", utterance(tts, "queued line"))
        await asyncio.sleep(0.08)
        assert h.sent == []
        await h.controller.on_vad_offset("operator")
        await wait_until(lambda: len(h.sent) == 2)
        h.controller.close()
    assert h.recorder.named("tts_completed") != []


async def test_stale_queue_entries_are_dropped_not_played() -> None:
    now = {"ms": 0.0}
    h = make_harness(max_queue_ms=3000.0, clock=lambda: now["ms"])
    tts = FakeTTS(frame_count=2)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        await h.controller.on_vad_onset("operator")
        await h.controller.submit("a2b", utterance(tts, "stale one"))
        await h.controller.submit("a2b", utterance(tts, "stale two"))
        now["ms"] = 3500.0
        await h.controller.submit("a2b", utterance(tts, "fresh"))
        await h.controller.on_vad_offset("operator")
        await wait_until(lambda: len(h.recorder.named("tts_completed")) == 1)
        h.controller.close()
    assert len(h.recorder.named("queue_dropped")) == 2
    assert {m for _, m in h.sent} == {tts_marker("fresh")}


async def test_queued_utterances_play_in_submission_order() -> None:
    h = make_harness()
    tts = FakeTTS(frame_count=1, ttfa_ms=1.0, frame_interval_ms=1.0)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        for text in ("first", "second", "third"):
            await h.controller.submit("b2a", utterance(tts, text))
        await wait_until(lambda: len(h.sent) == 3)
        h.controller.close()
    assert [m for _, m in h.sent] == [tts_marker(t) for t in ("first", "second", "third")]
    assert all(d == "b2a" for d, _ in h.sent)


async def test_state_machine_walks_the_adr006_states() -> None:
    h = make_harness()
    tts = FakeTTS(frame_count=2, ttfa_ms=20.0)
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        assert h.controller.state("a2b") is DirectionState.IDLE
        await h.controller.on_vad_onset("caller")
        assert h.controller.state("a2b") is DirectionState.LISTENING
        h.controller.note_translating("a2b")
        assert h.controller.state("a2b") is DirectionState.TRANSLATING
        await h.controller.on_vad_offset("caller")
        await h.controller.submit("a2b", utterance(tts, "hi"))
        await wait_until(lambda: h.controller.state("a2b") is DirectionState.SPEAKING)
        await wait_until(lambda: h.controller.state("a2b") is DirectionState.IDLE)
        h.controller.close()


async def test_barge_in_without_active_playback_is_not_an_event() -> None:
    h = make_harness()
    async with asyncio.TaskGroup() as tg:
        h.controller.start(tg)
        await h.controller.on_vad_onset("operator")
        await h.controller.on_vad_offset("operator")
        h.controller.close()
    assert h.recorder.named("barge_in") == []
    assert h.recorder.named("tts_cancelled") == []
