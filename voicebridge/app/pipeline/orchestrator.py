"""Per-session task wiring (SPEC.md §3.2).

Two independent direction pipelines share only the session context, the
duplex controller and the event bus. Plain ``asyncio.TaskGroup`` and plain
queues — no clever async patterns.

The feedback-loop guard (ADR-006) is structural here: ASR input comes
exclusively from ``adapter.inbound_audio`` on the *source* leg, and synthesized
audio goes exclusively to ``adapter.send_audio`` on the *target* leg. There is
no code path from playback to an ASR push, and the orchestrator test proves it
at the byte level.
"""

import asyncio
import contextlib
import functools
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

from app.audio.frames import AudioFrame, require_internal
from app.audio.vad import VoiceActivityDetector
from app.config import DuplexConfig, SegmenterConfig
from app.observability.events import EventBus, monotonic_ms
from app.pipeline.duplex import DuplexController, Utterance
from app.pipeline.segmenter import Commit, Segmenter
from app.providers.base import (
    ASROptions,
    ASRProvider,
    Glossary,
    Translator,
    TTSProvider,
    Turn,
    VoiceSpec,
)
from app.telephony.base import CallLegs, Leg, TelephonyAdapter
from app.types import Direction, source_side, target_side


@dataclass(slots=True)
class DirectionPipeline:
    direction: Direction
    source_lang: str
    target_lang: str
    asr: ASRProvider
    vad: VoiceActivityDetector
    segmenter: Segmenter
    tts: TTSProvider
    voice: VoiceSpec


class SessionOrchestrator:
    def __init__(
        self,
        *,
        session_id: str,
        adapter: TelephonyAdapter,
        legs: CallLegs,
        pipelines: Sequence[DirectionPipeline],
        translator: Translator,
        events: EventBus,
        segmenter_config: SegmenterConfig,
        duplex_config: DuplexConfig,
        glossary: Glossary | None = None,
        context_turns: int = 6,
        tick_interval_ms: float = 50.0,
    ) -> None:
        self._session_id = session_id
        self._adapter = adapter
        self._legs = legs
        self._pipelines = pipelines
        self._translator = translator
        self._events = events
        self._seg_cfg = segmenter_config
        self._glossary = glossary
        self._context: deque[Turn] = deque(maxlen=context_turns)
        self._tick_interval_ms = tick_interval_ms
        self._stop_ticker = asyncio.Event()
        self._commit_queues: dict[Direction, asyncio.Queue[Commit | None]] = {
            p.direction: asyncio.Queue() for p in pipelines
        }
        self.duplex = DuplexController(
            config=duplex_config,
            events=events,
            send_frame=self._send_frame,
            flush=self._flush,
        )

    # --- egress (used only by the duplex controller) ------------------------

    def _target_leg(self, direction: Direction) -> Leg:
        side = target_side(direction)
        return self._legs.caller if side == "caller" else self._legs.operator

    def _source_leg(self, direction: Direction) -> Leg:
        side = source_side(direction)
        return self._legs.caller if side == "caller" else self._legs.operator

    async def _send_frame(self, direction: Direction, frame: AudioFrame) -> None:
        await self._adapter.send_audio(self._target_leg(direction), require_internal(frame))

    async def _flush(self, direction: Direction) -> None:
        await self._adapter.flush_outbound(self._target_leg(direction))

    # --- lifecycle ----------------------------------------------------------

    async def run(self) -> None:
        self._events.emit("call_started")
        try:
            for pipeline in self._pipelines:
                await pipeline.asr.open(pipeline.source_lang, ASROptions())
            for leg in (self._legs.caller, self._legs.operator):
                self._events.emit("leg_connected", side=leg.side)
            async with asyncio.TaskGroup() as tg:
                self.duplex.start(tg)
                workers = [tg.create_task(self._translate_worker(p)) for p in self._pipelines]
                consumers = [tg.create_task(self._consume_asr(p)) for p in self._pipelines]
                tg.create_task(self._ticker())
                pumps = [tg.create_task(self._pump_audio(p)) for p in self._pipelines]
                # A side with no pipeline still streams audio at us; left unread
                # it fills the socket buffer and eventually stalls the
                # connection.
                translated = {source_side(p.direction) for p in self._pipelines}
                drains = [
                    tg.create_task(self._discard_audio(leg))
                    for leg in (self._legs.caller, self._legs.operator)
                    if leg.side not in translated
                ]
                tg.create_task(self._supervise([*pumps, *drains], consumers, workers))
        finally:
            # The orderly drain in _supervise closes these on a healthy call,
            # but a call that dies never reaches it, and a vendor stream that
            # outlives its call holds a slot in the account's concurrency limit
            # until the vendor times it out. Closing twice is a no-op.
            await self._close_streams()
        self._events.emit("call_ended")

    async def _close_streams(self) -> None:
        for pipeline in self._pipelines:
            with contextlib.suppress(Exception):
                await pipeline.asr.close()

    async def _supervise(
        self,
        pumps: list[asyncio.Task[None]],
        consumers: list[asyncio.Task[None]],
        workers: list[asyncio.Task[None]],
    ) -> None:
        # Orderly drain: inbound audio ends -> ASR streams close -> pending
        # commits translate -> playback stops. Each stage ends the next one's
        # input instead of cancelling it.
        await asyncio.gather(*pumps)
        await self._close_streams()
        await asyncio.gather(*consumers)
        for queue in self._commit_queues.values():
            queue.put_nowait(None)
        await asyncio.gather(*workers)
        self._stop_ticker.set()
        self.duplex.close()

    # --- pipeline stages ----------------------------------------------------

    async def _pump_audio(self, p: DirectionPipeline) -> None:
        side = source_side(p.direction)
        silence_fired = False
        async for frame in self._adapter.inbound_audio(self._source_leg(p.direction)):
            require_internal(frame)
            now = monotonic_ms()
            vad_result = p.vad.process(frame)
            if vad_result.onset:
                silence_fired = False
                self._events.emit("speech_start", direction=p.direction)
                await self.duplex.on_vad_onset(side)
            if (
                not vad_result.is_speech
                and not silence_fired
                and vad_result.silence_ms >= self._seg_cfg.vad_silence_ms
            ):
                silence_fired = True
                commit = p.segmenter.on_vad_silence(now)
                if commit is not None:
                    await self._enqueue_commit(p, commit)
                await self.duplex.on_vad_offset(side)
            await p.asr.push(frame)

    async def _discard_audio(self, leg: Leg) -> None:
        with contextlib.suppress(Exception):
            async for _ in self._adapter.inbound_audio(leg):
                pass

    async def _consume_asr(self, p: DirectionPipeline) -> None:
        async for result in p.asr.results():
            now = monotonic_ms()
            self._events.emit(
                "asr_final" if result.is_final else "asr_partial",
                direction=p.direction,
                text=result.text,
            )
            commit = p.segmenter.on_asr_result(result, now)
            if commit is not None:
                await self._enqueue_commit(p, commit)

    async def _ticker(self) -> None:
        # Timeout commits (ADR-004 trigger 3) must fire even when the ASR goes
        # quiet mid-utterance, so they cannot ride on result arrival alone.
        while True:
            try:
                await asyncio.wait_for(self._stop_ticker.wait(), self._tick_interval_ms / 1000.0)
                return
            except TimeoutError:
                pass
            for pipeline in self._pipelines:
                commit = pipeline.segmenter.poll(monotonic_ms())
                if commit is not None:
                    await self._enqueue_commit(pipeline, commit)

    async def _enqueue_commit(self, p: DirectionPipeline, commit: Commit) -> None:
        self._events.emit(
            "segment_committed",
            direction=p.direction,
            correlation_id=commit.correlation_id,
            trigger=commit.trigger.value,
            text=commit.text,
        )
        self.duplex.note_translating(p.direction)
        await self._commit_queues[p.direction].put(commit)

    async def _translate_worker(self, p: DirectionPipeline) -> None:
        queue = self._commit_queues[p.direction]
        while True:
            commit = await queue.get()
            if commit is None:
                return
            try:
                await self._handle_commit(p, commit)
            except Exception as exc:
                self._events.emit(
                    "error",
                    direction=p.direction,
                    correlation_id=commit.correlation_id,
                    stage="mt_tts",
                    detail=repr(exc),
                )

    async def _handle_commit(self, p: DirectionPipeline, commit: Commit) -> None:
        self._events.emit("mt_started", direction=p.direction, correlation_id=commit.correlation_id)
        translation = await self._translator.translate(
            commit.text,
            p.source_lang,
            p.target_lang,
            context=list(self._context),
            glossary=self._glossary,
            tier="fast",
        )
        self._events.emit(
            "mt_completed",
            direction=p.direction,
            correlation_id=commit.correlation_id,
            source_text=commit.text,
            translated_text=translation.text,
        )
        self._context.append(
            Turn(
                direction=p.direction,
                source_lang=p.source_lang,
                target_lang=p.target_lang,
                source_text=commit.text,
                translated_text=translation.text,
            )
        )
        self._events.emit(
            "tts_started", direction=p.direction, correlation_id=commit.correlation_id
        )
        synthesis = p.tts.synthesize(translation.text, p.voice)
        await self.duplex.submit(
            p.direction,
            Utterance(
                correlation_id=commit.correlation_id,
                text=translation.text,
                synthesis=synthesis,
                cancel=functools.partial(p.tts.cancel, synthesis.handle),
            ),
        )
