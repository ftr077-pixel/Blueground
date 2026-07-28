"""Speechmatics real-time ASR client (ADR-003 — the Hebrew side).

Wire protocol, as used here:

    client -> vendor:  {"message": "StartRecognition", "audio_format": {...},
                        "transcription_config": {...}}
                       <binary>                       raw PCM16LE mono
                       {"message": "EndOfStream", "last_seq_no": N}
    vendor -> client:  {"message": "RecognitionStarted", "id": ...}
                       {"message": "AddPartialTranscript", "metadata": {...},
                        "results": [...]}
                       {"message": "AddTranscript", ...}     final
                       {"message": "AudioAdded", "seq_no": N}
                       {"message": "Error" | "Warning", ...}

Speechmatics has no application-level ping, so the heartbeat here is
receive-side only: ``AudioAdded`` acknowledgements arrive continuously while
audio flows, and their absence past the timeout is what exposes a silently
dead socket (CLAUDE.md). Recovery is redial + re-StartRecognition; the vendor
keeps no state we need to replay, and partials lost across the gap are
absorbed by the segmenter's timeout and VAD triggers.

UNVERIFIED against the live API: implemented from the documented protocol and
exercised against a fake. Confirm on the first real call.
"""

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame, require_internal
from app.observability.events import monotonic_ms
from app.providers.base import ASROptions, ASRResult, Word
from app.transport import MessageStream

Dialer = Callable[[], Awaitable[MessageStream]]

DEFAULT_ENDPOINT = "wss://eu2.rt.speechmatics.com/v2"


class AsrStreamError(ConnectionError):
    pass


@dataclass(frozen=True, slots=True)
class SpeechmaticsConfig:
    api_key: str
    endpoint: str = DEFAULT_ENDPOINT
    operating_point: str = "enhanced"
    max_delay_s: float = 1.0
    """Vendor-side endpointing delay. Lower is faster and less accurate; this
    is tuned against the §8.2 fixtures alongside the ADR-004 thresholds."""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "SpeechmaticsConfig":
        e = os.environ if env is None else env
        api_key = e.get("SPEECHMATICS_API_KEY")
        if not api_key:
            raise RuntimeError("SPEECHMATICS_API_KEY must be set")
        return cls(
            api_key=api_key,
            endpoint=e.get("SPEECHMATICS_ENDPOINT", DEFAULT_ENDPOINT),
            operating_point=e.get("SPEECHMATICS_OPERATING_POINT", "enhanced"),
            max_delay_s=float(e.get("SPEECHMATICS_MAX_DELAY_S", "1.0")),
        )

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    def start_message(self, language: str, opts: ASROptions) -> dict[str, Any]:
        config: dict[str, Any] = {
            "language": language,
            "operating_point": self.operating_point,
            "enable_partials": True,
            "max_delay": self.max_delay_s,
        }
        if opts.keyterms:
            config["additional_vocab"] = [{"content": term} for term in opts.keyterms]
        return {
            "message": "StartRecognition",
            "audio_format": {
                "type": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": opts.sample_rate,
            },
            "transcription_config": config,
        }


class SpeechmaticsASR:
    def __init__(
        self,
        dial: Dialer,
        config: SpeechmaticsConfig,
        *,
        heartbeat_interval_s: float = 5.0,
        heartbeat_timeout_s: float = 10.0,
        max_redials: int = 3,
        redial_base_delay_s: float = 0.1,
    ) -> None:
        self._dial = dial
        self._config = config
        self._heartbeat_interval_s = heartbeat_interval_s
        self._heartbeat_timeout_s = heartbeat_timeout_s
        self._max_redials = max_redials
        self._redial_base_delay_s = redial_base_delay_s
        self._queue: asyncio.Queue[ASRResult | None] = asyncio.Queue()
        self._ws: MessageStream | None = None
        self._language = ""
        self._opts = ASROptions()
        self._generation = 0
        self._seq_no = 0
        self._redial_lock = asyncio.Lock()
        self._closing = False
        self._error: Exception | None = None
        self._last_rx_ms = 0.0
        self._reader_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None

    # --- ASRProvider --------------------------------------------------------

    async def open(self, language: str, opts: ASROptions) -> None:
        if opts.sample_rate != INTERNAL_SAMPLE_RATE:
            raise ValueError(f"expected {INTERNAL_SAMPLE_RATE} Hz, got {opts.sample_rate}")
        self._language = language
        self._opts = opts
        self._ws = await self._dial_and_start()
        self._last_rx_ms = monotonic_ms()
        self._reader_task = asyncio.create_task(self._reader())
        self._heartbeat_task = asyncio.create_task(self._heartbeat())

    async def push(self, frame: AudioFrame) -> None:
        require_internal(frame)
        generation = self._generation
        try:
            await self._require_ws().send(frame.pcm)
        except (OSError, ConnectionError):
            await self._reconnect(generation)
            await self._require_ws().send(frame.pcm)
        self._seq_no += 1

    def results(self) -> AsyncIterator[ASRResult]:
        return self._results()

    async def close(self) -> None:
        self._closing = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(OSError, ConnectionError):
                await ws.send(json.dumps({"message": "EndOfStream", "last_seq_no": self._seq_no}))
            with contextlib.suppress(OSError, ConnectionError):
                await ws.close()
        if self._reader_task is not None:
            try:
                await asyncio.wait_for(self._reader_task, timeout=1.0)
            except TimeoutError:
                self._reader_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._reader_task
        self._queue.put_nowait(None)

    # --- internals ----------------------------------------------------------

    def _require_ws(self) -> MessageStream:
        if self._ws is None:
            raise AsrStreamError("asr stream is not open")
        return self._ws

    async def _results(self) -> AsyncIterator[ASRResult]:
        while True:
            item = await self._queue.get()
            if item is None:
                if self._error is not None:
                    raise self._error
                return
            yield item

    async def _dial_and_start(self) -> MessageStream:
        delay = self._redial_base_delay_s
        for attempt in range(self._max_redials + 1):
            try:
                ws = await self._dial()
                await ws.send(json.dumps(self._config.start_message(self._language, self._opts)))
                while True:
                    raw = await ws.recv()
                    if raw is None:
                        raise AsrStreamError("speechmatics closed during StartRecognition")
                    if isinstance(raw, bytes):
                        continue
                    message = json.loads(raw)
                    kind = message.get("message")
                    if kind == "RecognitionStarted":
                        self._seq_no = 0
                        return ws
                    if kind == "Error":
                        raise AsrStreamError(str(message.get("reason") or message.get("type")))
            except (OSError, ConnectionError) as exc:
                if attempt >= self._max_redials:
                    raise AsrStreamError(f"asr dial failed after {attempt + 1} attempts") from exc
                await asyncio.sleep(delay)
                delay *= 2
        raise AsrStreamError("unreachable")

    async def _reconnect(self, seen_generation: int) -> None:
        async with self._redial_lock:
            if self._closing or self._generation != seen_generation:
                # Someone else already replaced the socket.
                return
            old = self._ws
            if old is not None:
                # Unblocks a reader stuck in recv() on the dead socket.
                with contextlib.suppress(OSError, ConnectionError):
                    await old.close()
            self._ws = await self._dial_and_start()
            self._generation += 1
            self._last_rx_ms = monotonic_ms()

    async def _reader(self) -> None:
        while not self._closing:
            generation = self._generation
            try:
                raw = await self._require_ws().recv()
            except (OSError, ConnectionError):
                raw = None
            if raw is None:
                if self._closing:
                    break
                try:
                    await self._reconnect(generation)
                except AsrStreamError as exc:
                    self._error = exc
                    break
                continue
            self._last_rx_ms = monotonic_ms()
            if isinstance(raw, bytes):
                continue
            message = json.loads(raw)
            kind = message.get("message")
            if kind in ("AddTranscript", "AddPartialTranscript"):
                result = self._parse_transcript(message, is_final=kind == "AddTranscript")
                if result is not None:
                    self._queue.put_nowait(result)
            elif kind == "Error":
                self._error = AsrStreamError(str(message.get("reason") or message.get("type")))
                break
            # AudioAdded, Warning, Info only refresh the receive clock
        self._queue.put_nowait(None)

    async def _heartbeat(self) -> None:
        while not self._closing:
            await asyncio.sleep(self._heartbeat_interval_s)
            if self._closing:
                return
            if self._ws is None:
                continue
            if monotonic_ms() - self._last_rx_ms > self._heartbeat_timeout_s * 1000.0:
                with contextlib.suppress(AsrStreamError):
                    await self._reconnect(self._generation)

    def _parse_transcript(self, message: Any, is_final: bool) -> ASRResult | None:
        metadata = message.get("metadata") or {}
        text = str(metadata.get("transcript") or "").strip()
        if not text:
            return None
        words: list[Word] = []
        confidences: list[float] = []
        for item in message.get("results") or ():
            alternatives = item.get("alternatives") or []
            if not alternatives or item.get("type") == "punctuation":
                continue
            best = alternatives[0]
            confidence = best.get("confidence")
            if confidence is not None:
                confidences.append(float(confidence))
            words.append(
                Word(
                    text=str(best.get("content") or ""),
                    start_ms=float(item.get("start_time") or 0.0) * 1000.0,
                    end_ms=float(item.get("end_time") or 0.0) * 1000.0,
                    confidence=None if confidence is None else float(confidence),
                )
            )
        return ASRResult(
            text=text,
            is_final=is_final,
            confidence=(sum(confidences) / len(confidences)) if confidences else None,
            words=tuple(words),
            received_at=monotonic_ms(),
        )
