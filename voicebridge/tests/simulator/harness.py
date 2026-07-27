"""Call simulator (SPEC.md §8.3): replays a scripted conversation through the
full pipeline at wall-clock speed against the fake telephony adapter, and
reports the measured latency distribution.

Until the §8.2 fixture corpus exists, scripts are synthetic: utterance
timelines drive both the audio feeders (speech vs silence frames) and the
scripted ASR partial cadence. The harness and its assertions carry over
unchanged once real fixture audio and vendor ASR transcripts replace them.
"""

import asyncio
import statistics
from dataclasses import dataclass, field

from app.config import DuplexConfig, SegmenterConfig
from app.observability.events import EventBus, EventRecorder
from app.pipeline.languages import ENGLISH, HEBREW
from app.pipeline.orchestrator import DirectionPipeline, SessionOrchestrator
from app.pipeline.segmenter import Segmenter
from app.providers.base import ASRResult, VoiceSpec
from app.telephony.base import CallContext, CallLegs, Leg
from app.types import Side
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
)

PARTIAL_INTERVAL_MS = 160.0
WORD_MS = 230.0
MIN_UTTERANCE_MS = 600.0
ENDPOINT_LAG_MS = 120.0
GAP_MS = 800.0
TAIL_MS = 2000.0
FRAME_MS = 20.0


@dataclass(frozen=True, slots=True)
class Utt:
    side: Side
    text: str
    translation: str


@dataclass(frozen=True, slots=True)
class _Window:
    start_ms: float
    end_ms: float


@dataclass(slots=True)
class SimReport:
    committed_texts: list[str]
    translations_in_order: list[str]
    commit_to_first_audio_ms: list[float]
    barge_ins: int
    queue_drops: int
    errors: int
    recorder: EventRecorder
    adapter: FakeTelephonyAdapter
    legs: CallLegs
    caller_asr: ScriptedASR
    operator_asr: ScriptedASR

    @property
    def p50_ms(self) -> float:
        return statistics.median(self.commit_to_first_audio_ms)

    @property
    def p95_ms(self) -> float:
        if len(self.commit_to_first_audio_ms) == 1:
            return self.commit_to_first_audio_ms[0]
        ordered = sorted(self.commit_to_first_audio_ms)
        return ordered[max(0, round(0.95 * len(ordered)) - 1)]


def _partial(text: str, at_ms: float) -> ScriptedResult:
    return ScriptedResult(
        at_ms, ASRResult(text=text, is_final=False, confidence=None, words=(), received_at=0.0)
    )


def _final(text: str, at_ms: float) -> ScriptedResult:
    return ScriptedResult(
        at_ms, ASRResult(text=text, is_final=True, confidence=None, words=(), received_at=0.0)
    )


@dataclass(slots=True)
class SimulatedCall:
    script: list[Utt]
    tts_a2b: FakeTTS = field(default_factory=FakeTTS)
    tts_b2a: FakeTTS = field(default_factory=FakeTTS)
    gap_ms: float = GAP_MS
    table_override: dict[str, str] | None = None

    async def run_with_table(self, table: dict[str, str]) -> "SimReport":
        """Run with an explicit phrase table, for scripts whose utterances the
        segmenter is expected to split into multiple commits."""
        self.table_override = table
        return await self.run()

    def _timeline(
        self,
    ) -> tuple[dict[Side, list[ScriptedResult]], dict[Side, list[_Window]], float]:
        asr_scripts: dict[Side, list[ScriptedResult]] = {"caller": [], "operator": []}
        windows: dict[Side, list[_Window]] = {"caller": [], "operator": []}
        cursor = 0.0
        last_final = 0.0
        for utt in self.script:
            words = utt.text.split()
            duration = max(MIN_UTTERANCE_MS, len(words) * WORD_MS)
            for k in range(1, len(words) + 1):
                at = cursor + k * PARTIAL_INTERVAL_MS
                if at < cursor + duration:
                    asr_scripts[utt.side].append(_partial(" ".join(words[:k]), at))
            final_at = cursor + duration + ENDPOINT_LAG_MS
            asr_scripts[utt.side].append(_final(utt.text, final_at))
            windows[utt.side].append(_Window(cursor, cursor + duration))
            last_final = max(last_final, final_at)
            cursor += duration + self.gap_ms
        return asr_scripts, windows, last_final + TAIL_MS

    async def run(self) -> SimReport:
        asr_scripts, windows, end_ms = self._timeline()
        adapter = FakeTelephonyAdapter()
        legs = await adapter.accept_call(
            CallContext(session_id="sim", caller_language="he", operator_language="en")
        )
        recorder = EventRecorder()
        bus = EventBus("sim", (recorder,))
        caller_asr = ScriptedASR(asr_scripts["caller"])
        operator_asr = ScriptedASR(asr_scripts["operator"])
        table = (
            self.table_override
            if self.table_override is not None
            else {utt.text: utt.translation for utt in self.script}
        )
        translator = DictTranslator(table)
        seg_cfg = SegmenterConfig()
        pipelines = (
            DirectionPipeline(
                direction="a2b",
                source_lang="he",
                target_lang="en",
                asr=caller_asr,
                vad=EnergyVad(),
                segmenter=Segmenter(seg_cfg, HEBREW),
                tts=self.tts_a2b,
                voice=VoiceSpec(voice_id="en-neutral", language="en"),
            ),
            DirectionPipeline(
                direction="b2a",
                source_lang="en",
                target_lang="he",
                asr=operator_asr,
                vad=EnergyVad(),
                segmenter=Segmenter(seg_cfg, ENGLISH),
                tts=self.tts_b2a,
                voice=VoiceSpec(voice_id="he-neutral", language="he"),
            ),
        )
        orchestrator = SessionOrchestrator(
            session_id="sim",
            adapter=adapter,
            legs=legs,
            pipelines=pipelines,
            translator=translator,
            events=bus,
            segmenter_config=seg_cfg,
            duplex_config=DuplexConfig(),
        )

        async def feed(side: Side, leg: Leg) -> None:
            loop = asyncio.get_running_loop()
            started = loop.time()
            n_frames = int(end_ms / FRAME_MS)
            for i in range(n_frames):
                target_s = started + i * FRAME_MS / 1000.0
                delay = target_s - loop.time()
                if delay > 0:
                    await asyncio.sleep(delay)
                t = i * FRAME_MS
                speaking = any(w.start_ms <= t < w.end_ms for w in windows[side])
                frame = speech_frame(t) if speaking else silence_frame(t)
                await adapter.feed(leg, frame)
            await adapter.end_inbound(leg)

        async with asyncio.TaskGroup() as tg:
            run_task = tg.create_task(orchestrator.run())
            tg.create_task(feed("caller", legs.caller))
            tg.create_task(feed("operator", legs.operator))
            await asyncio.wait_for(run_task, timeout=end_ms / 1000.0 + 20.0)

        latencies: list[float] = []
        for committed in recorder.named("segment_committed"):
            assert committed.correlation_id is not None
            chain = recorder.for_correlation(committed.correlation_id)
            first_audio = [e for e in chain if e.name == "tts_first_audio"]
            if first_audio:
                latencies.append(first_audio[0].monotonic_ts - committed.monotonic_ts)
        return SimReport(
            committed_texts=[str(e.payload["text"]) for e in recorder.named("segment_committed")],
            translations_in_order=[
                str(e.payload["translated_text"]) for e in recorder.named("mt_completed")
            ],
            commit_to_first_audio_ms=latencies,
            barge_ins=len(recorder.named("barge_in")),
            queue_drops=len(recorder.named("queue_dropped")),
            errors=len(recorder.named("error")),
            recorder=recorder,
            adapter=adapter,
            legs=legs,
            caller_asr=caller_asr,
            operator_asr=operator_asr,
        )


def assert_no_feedback_loop(report: SimReport, translations: list[str]) -> None:
    """§8.5 chaos case: no synthesized frame content may appear in ASR input."""
    from tests.support.fakes import tts_marker

    tts_markers = {tts_marker(text) for text in translations}
    for asr in (report.caller_asr, report.operator_asr):
        assert asr.pushed_frames != []
        for frame in asr.pushed_frames:
            assert marker_of(frame) not in tts_markers
