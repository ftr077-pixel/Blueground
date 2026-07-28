"""Deepgram streaming ASR client (ADR-003).

Wire protocol, as used here:

    client -> vendor:  raw PCM16LE mono binary frames
                       {"type": "KeepAlive"}     heartbeat
                       {"type": "CloseStream"}   graceful end
    vendor -> client:  {"type": "Results", "is_final": bool,
                        "channel": {"alternatives": [{"transcript": "...",
                                    "confidence": 0.9, "words": [...]}]}}
                       {"type": "Metadata" | "SpeechStarted" | ...}

The connection is opened by an injected dialer (``dial``), so URL construction
and credentials live in configuration and the client stays testable offline.

Heartbeat + reconnect are mandatory for every streaming vendor connection
(CLAUDE.md): a silently dead socket blocks ``recv`` forever, so the heartbeat
is the component that notices — it closes the corpse to unblock the reader,
redials, and resumes. Partials lost across the gap are absorbed by the
segmenter's timeout and VAD triggers, and the stream carries no server-side
state that would need replaying.
"""

import asyncio
import contextlib
import json
import os
import urllib.parse
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame, require_internal
from app.observability.events import monotonic_ms
from app.providers.base import ASROptions, ASRResult, Word
from app.transport import MessageStream

Dialer = Callable[[], Awaitable[MessageStream]]

DEFAULT_ENDPOINT = "wss://api.deepgram.com/v1/listen"


class AsrStreamError(ConnectionError):
    pass


@dataclass(frozen=True, slots=True)
class DeepgramConfig:
    api_key: str
    model: str = "nova-3"
    endpoint: str = DEFAULT_ENDPOINT

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "DeepgramConfig":
        e = os.environ if env is None else env
        api_key = e.get("DEEPGRAM_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPGRAM_API_KEY must be set")
        return cls(
            api_key=api_key,
            model=e.get("DEEPGRAM_MODEL", "nova-3"),
            endpoint=e.get("DEEPGRAM_ENDPOINT", DEFAULT_ENDPOINT),
        )

    def stream_url(self, language: str, opts: ASROptions) -> str:
        query = {
            "model": self.model,
            "language": language,
            "encoding": "linear16",
            "sample_rate": str(opts.sample_rate),
            "channels": "1",
            "interim_results": "true",
            "punctuate": "true",
            # Vendor endpointing is ADR-004's trigger 1; our segmenter owns
            # the rest of the decision.
            "endpointing": "300",
        }
        if opts.keyterms:
            query["keyterm"] = " ".join(opts.keyterms)
        return f"{self.endpoint}?{urllib.parse.urlencode(query)}"

    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Token {self.api_key}"}


class DeepgramASR:
    def __init__(
        self,
        dial: Dialer,
        *,
        heartbeat_interval_s: float = 5.0,
        heartbeat_timeout_s: float = 10.0,
        max_redials: int = 3,
        redial_base_delay_s: float = 0.1,
    ) -> None:
        self._dial = dial
        self._heartbeat_interval_s = heartbeat_interval_s
        self._heartbeat_timeout_s = heartbeat_timeout_s
        self._max_redials = max_redials
        self._redial_base_delay_s = redial_base_delay_s
        self._queue: asyncio.Queue[ASRResult | None] = asyncio.Queue()
        self._ws: MessageStream | None = None
        self._generation = 0
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
        self._ws = await self._dial_with_retries()
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

    def results(self) -> AsyncIterator[ASRResult]:
        return self._results()

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(OSError, ConnectionError):
                await ws.send(json.dumps({"type": "CloseStream"}))
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

    async def _dial_with_retries(self) -> MessageStream:
        delay = self._redial_base_delay_s
        for attempt in range(self._max_redials + 1):
            try:
                return await self._dial()
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
            self._ws = await self._dial_with_retries()
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
            kind = message.get("type")
            if kind == "Results":
                result = self._parse_results(message)
                if result is not None:
                    self._queue.put_nowait(result)
            elif kind == "Error":
                self._error = AsrStreamError(str(message.get("description") or message))
                break
            # Metadata, SpeechStarted and unknown types only refresh the clock
        self._queue.put_nowait(None)

    async def _heartbeat(self) -> None:
        while not self._closing:
            await asyncio.sleep(self._heartbeat_interval_s)
            if self._closing:
                return
            generation = self._generation
            ws = self._ws
            if ws is None:
                continue
            with contextlib.suppress(OSError, ConnectionError):
                await ws.send(json.dumps({"type": "KeepAlive"}))
            if monotonic_ms() - self._last_rx_ms > self._heartbeat_timeout_s * 1000.0:
                with contextlib.suppress(AsrStreamError):
                    await self._reconnect(generation)

    def _parse_results(self, message: Any) -> ASRResult | None:
        alternatives = message.get("channel", {}).get("alternatives") or []
        if not alternatives:
            return None
        best = alternatives[0]
        text = str(best.get("transcript") or "")
        if not text:
            # Empty interim results arrive during silence and carry nothing
            # the segmenter can use.
            return None
        words = tuple(
            Word(
                text=str(word.get("punctuated_word") or word["word"]),
                start_ms=float(word["start"]) * 1000.0,
                end_ms=float(word["end"]) * 1000.0,
                confidence=None if word.get("confidence") is None else float(word["confidence"]),
            )
            for word in best.get("words") or ()
        )
        confidence = best.get("confidence")
        return ASRResult(
            text=text,
            is_final=bool(message.get("is_final")),
            confidence=None if confidence is None else float(confidence),
            words=words,
            received_at=monotonic_ms(),
        )
