"""End-to-end orchestrator tests over fakes: one Hebrew utterance travels
caller -> ASR -> segmenter -> MT -> TTS -> operator leg, with the correlation
ID threaded through every stage event, and synthesized audio provably never
reaching any ASR input."""

import asyncio
from dataclasses import dataclass

import pytest

from app.config import DuplexConfig, SegmenterConfig
from app.observability.events import EventBus, EventRecorder
from app.pipeline.languages import ENGLISH, HEBREW
from app.pipeline.orchestrator import DirectionPipeline, SessionOrchestrator
from app.pipeline.segmenter import Segmenter
from app.providers.base import (
    ASROptions,
    ASRResult,
    Glossary,
    Tier,
    Translation,
    Turn,
    VoiceSpec,
)
from app.telephony.base import CallContext, CallLegs
from tests.support.fakes import (
    DictTranslator,
    EnergyVad,
    FakeTelephonyAdapter,
    FakeTTS,
    ScriptedASR,
    ScriptedResult,
    marker_of,
    silence_frame,
    speech_frame,
    tts_marker,
    wait_until,
)

SEG_CFG = SegmenterConfig()
DUP_CFG = DuplexConfig()


def partial(text: str, at_ms: float) -> ScriptedResult:
    return ScriptedResult(
        at_ms, ASRResult(text=text, is_final=False, confidence=None, words=(), received_at=0.0)
    )


def final(text: str, at_ms: float) -> ScriptedResult:
    return ScriptedResult(
        at_ms, ASRResult(text=text, is_final=True, confidence=None, words=(), received_at=0.0)
    )


@dataclass
class Session:
    orchestrator: SessionOrchestrator
    adapter: FakeTelephonyAdapter
    legs: CallLegs
    recorder: EventRecorder
    caller_asr: ScriptedASR
    operator_asr: ScriptedASR
    translator: DictTranslator
    tts_a2b: FakeTTS
    tts_b2a: FakeTTS


async def build_session(
    caller_script: list[ScriptedResult],
    operator_script: list[ScriptedResult],
    table: dict[str, str],
    tts_a2b: FakeTTS | None = None,
) -> Session:
    adapter = FakeTelephonyAdapter()
    legs = await adapter.accept_call(
        CallContext(session_id="s-test", caller_language="he", operator_language="en")
    )
    recorder = EventRecorder()
    bus = EventBus("s-test", (recorder,))
    caller_asr = ScriptedASR(caller_script)
    operator_asr = ScriptedASR(operator_script)
    translator = DictTranslator(table)
    tts_a = tts_a2b if tts_a2b is not None else FakeTTS()
    tts_b = FakeTTS()
    pipelines = (
        DirectionPipeline(
            direction="a2b",
            source_lang="he",
            target_lang="en",
            asr=caller_asr,
            vad=EnergyVad(),
            segmenter=Segmenter(SEG_CFG, HEBREW),
            tts=tts_a,
            voice=VoiceSpec(voice_id="en-neutral", language="en"),
        ),
        DirectionPipeline(
            direction="b2a",
            source_lang="en",
            target_lang="he",
            asr=operator_asr,
            vad=EnergyVad(),
            segmenter=Segmenter(SEG_CFG, ENGLISH),
            tts=tts_b,
            voice=VoiceSpec(voice_id="he-neutral", language="he"),
        ),
    )
    orchestrator = SessionOrchestrator(
        session_id="s-test",
        adapter=adapter,
        legs=legs,
        pipelines=pipelines,
        translator=translator,
        events=bus,
        segmenter_config=SEG_CFG,
        duplex_config=DUP_CFG,
    )
    return Session(
        orchestrator=orchestrator,
        adapter=adapter,
        legs=legs,
        recorder=recorder,
        caller_asr=caller_asr,
        operator_asr=operator_asr,
        translator=translator,
        tts_a2b=tts_a,
        tts_b2a=tts_b,
    )


async def feed_caller_utterance_then_silence(
    s: Session, stop: asyncio.Event, speech_frames: int = 25
) -> None:
    ts = 0.0
    for _ in range(speech_frames):
        await s.adapter.feed(s.legs.caller, speech_frame(ts))
        ts += 20.0
        await asyncio.sleep(0.01)
    while not stop.is_set():
        await s.adapter.feed(s.legs.caller, silence_frame(ts))
        ts += 20.0
        await asyncio.sleep(0.01)
    await s.adapter.end_inbound(s.legs.caller)


async def feed_operator_silence(s: Session, stop: asyncio.Event) -> None:
    ts = 0.0
    while not stop.is_set():
        await s.adapter.feed(s.legs.operator, silence_frame(ts))
        ts += 20.0
        await asyncio.sleep(0.01)
    await s.adapter.end_inbound(s.legs.operator)


async def test_single_utterance_flows_end_to_end() -> None:
    s = await build_session(
        caller_script=[partial("שלום", 120.0), final("שלום חבר", 300.0)],
        operator_script=[],
        table={"שלום חבר": "Hello friend"},
    )
    stop = asyncio.Event()
    async with asyncio.TaskGroup() as tg:
        run = tg.create_task(s.orchestrator.run())
        tg.create_task(feed_caller_utterance_then_silence(s, stop))
        tg.create_task(feed_operator_silence(s, stop))
        await wait_until(lambda: len(s.recorder.named("tts_completed")) == 1, timeout_s=5.0)
        stop.set()
        await asyncio.wait_for(run, timeout=5.0)

    committed = s.recorder.named("segment_committed")
    assert len(committed) == 1
    assert committed[0].payload["text"] == "שלום חבר"
    correlation = committed[0].correlation_id
    assert correlation is not None

    chain = [e.name for e in s.recorder.for_correlation(correlation)]
    assert chain == [
        "segment_committed",
        "mt_started",
        "mt_completed",
        "tts_started",
        "tts_first_audio",
        "tts_completed",
    ]

    assert s.translator.calls == [("שלום חבר", "he", "en", "fast")]
    operator_frames = s.adapter.sent_frames(s.legs.operator)
    assert operator_frames != []
    assert all(marker_of(f) == tts_marker("Hello friend") for f in operator_frames)
    assert s.adapter.sent_frames(s.legs.caller) == []

    names = list(s.recorder.names())
    assert names[0] == "call_started"
    assert names[-1] == "call_ended"
    assert s.recorder.named("error") == []


async def test_synthesized_audio_never_reaches_any_asr() -> None:
    """ADR-006 feedback-loop guard, proven at the byte level: every frame the
    ASRs saw came from an inbound leg, none carry a TTS content marker."""
    s = await build_session(
        caller_script=[final("שלום חבר", 250.0)],
        operator_script=[],
        table={"שלום חבר": "Hello friend"},
    )
    stop = asyncio.Event()
    async with asyncio.TaskGroup() as tg:
        run = tg.create_task(s.orchestrator.run())
        tg.create_task(feed_caller_utterance_then_silence(s, stop))
        tg.create_task(feed_operator_silence(s, stop))
        await wait_until(lambda: len(s.recorder.named("tts_completed")) == 1, timeout_s=5.0)
        # Keep both inbound streams open while playback audio sits in the
        # operator leg's outbound path — the dangerous window for a loop.
        await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(run, timeout=5.0)

    tts_bytes = tts_marker("Hello friend")
    assert s.adapter.sent_frames(s.legs.operator) != []
    for asr in (s.caller_asr, s.operator_asr):
        assert asr.pushed_frames != []
        assert all(marker_of(f) != tts_bytes for f in asr.pushed_frames)
    # The operator was silent: their ASR must have seen only silence.
    assert all(not any(f.pcm) for f in s.operator_asr.pushed_frames)


async def test_dialogue_context_threads_into_later_translations() -> None:
    s = await build_session(
        caller_script=[final("שלום", 200.0), final("מה שלומך", 700.0)],
        operator_script=[],
        table={"שלום": "Hello", "מה שלומך": "How are you"},
    )
    stop = asyncio.Event()
    async with asyncio.TaskGroup() as tg:
        run = tg.create_task(s.orchestrator.run())
        tg.create_task(feed_caller_utterance_then_silence(s, stop, speech_frames=40))
        tg.create_task(feed_operator_silence(s, stop))
        await wait_until(lambda: len(s.recorder.named("tts_completed")) == 2, timeout_s=5.0)
        stop.set()
        await asyncio.wait_for(run, timeout=5.0)

    assert len(s.translator.contexts) == 2
    assert s.translator.contexts[0] == []
    assert len(s.translator.contexts[1]) == 1
    assert s.translator.contexts[1][0].source_text == "שלום"
    assert s.translator.contexts[1][0].translated_text == "Hello"


class FailingTranslator:
    async def translate(
        self,
        text: str,
        source: str,
        target: str,
        context: list[Turn],
        glossary: Glossary | None,
        tier: Tier,
    ) -> Translation:
        raise RuntimeError("vendor 500")


async def test_translator_failure_emits_error_and_call_survives() -> None:
    s = await build_session(
        caller_script=[final("שלום", 200.0)],
        operator_script=[],
        table={},
    )
    s.orchestrator._translator = FailingTranslator()
    stop = asyncio.Event()
    async with asyncio.TaskGroup() as tg:
        run = tg.create_task(s.orchestrator.run())
        tg.create_task(feed_caller_utterance_then_silence(s, stop))
        tg.create_task(feed_operator_silence(s, stop))
        await wait_until(lambda: len(s.recorder.named("error")) == 1, timeout_s=5.0)
        stop.set()
        await asyncio.wait_for(run, timeout=5.0)

    assert s.recorder.named("error")[0].payload["stage"] == "mt_tts"
    assert s.recorder.events[-1].name == "call_ended"


class RefusingASR(ScriptedASR):
    """A vendor that rejects the stream at open, the way Speechmatics answers
    a call once the account's concurrent-stream limit is reached."""

    async def open(self, language: str, opts: ASROptions) -> None:
        raise ConnectionError("Concurrent Quota Exceeded")


async def test_a_call_that_cannot_start_still_closes_the_streams_it_opened() -> None:
    """Every stream left open holds a slot in the vendor's concurrency limit,
    so a call that dies at open must not leak the streams that did open —
    otherwise one failure makes every later call fail too."""
    s = await build_session(caller_script=[], operator_script=[], table={})
    refusing = RefusingASR([])
    s.orchestrator._pipelines = (
        s.orchestrator._pipelines[0],
        DirectionPipeline(
            direction="b2a",
            source_lang="en",
            target_lang="he",
            asr=refusing,
            vad=EnergyVad(),
            segmenter=Segmenter(SEG_CFG, ENGLISH),
            tts=s.tts_b2a,
            voice=VoiceSpec(voice_id="he-neutral", language="he"),
        ),
    )
    with pytest.raises(ConnectionError, match="Concurrent Quota Exceeded"):
        await s.orchestrator.run()
    assert s.caller_asr.closed
    assert s.recorder.named("call_ended") == []


async def test_a_call_that_dies_mid_stream_closes_the_streams() -> None:
    s = await build_session(caller_script=[], operator_script=[], table={})

    async def explode() -> None:
        raise RuntimeError("telephony leg died")

    s.orchestrator._pump_audio = lambda p: explode()  # type: ignore[method-assign]
    with pytest.raises(BaseExceptionGroup):
        await s.orchestrator.run()
    assert s.caller_asr.closed
    assert s.operator_asr.closed
