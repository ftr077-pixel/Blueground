"""Streaming ASR client for our own serving protocol (ADR-003 amendment A2).

The GPU host runs the matching server — faster-whisper behind this same
protocol — so the client carries no model assumptions at all. Wire protocol,
JSON text frames except audio:

    client -> server:
        {"type": "open", "language": "he", "sample_rate": 16000, "keyterms": []}
        <binary>                                # raw PCM16LE mono, 16 kHz
        {"type": "ping", "ts": <monotonic ms>}
        {"type": "close"}
    server -> client:
        {"type": "ready"}
        {"type": "result", "text": "...", "final": false, "confidence": 0.93,
         "words": [{"text": "...", "start_ms": 0, "end_ms": 120,
                    "confidence": 0.91}]}
        {"type": "pong", "ts": <echoed>}
        {"type": "error", "detail": "..."}

Heartbeat + reconnect are mandatory for every streaming vendor connection
(CLAUDE.md): a silently dead socket blocks ``recv`` forever, so the heartbeat
is the component that notices (pong timeout), closes the corpse to unblock
the reader, redials, and re-opens with the same parameters. Partials lost
across the gap are absorbed by the segmenter's timeout and VAD triggers.
"""

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from app.audio.frames import AudioFrame, require_internal
from app.observability.events import monotonic_ms
from app.providers.base import ASROptions, ASRResult, Word
from app.transport import MessageStream

Dialer = Callable[[], Awaitable[MessageStream]]


class AsrStreamError(ConnectionError):
    pass


class WsAsrClient:
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
        self._language = ""
        self._opts = ASROptions()
        self._generation = 0
        self._redial_lock = asyncio.Lock()
        self._closing = False
        self._error: Exception | None = None
        self._last_rx_ms = 0.0
        self._reader_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None

    # --- ASRProvider --------------------------------------------------------

    async def open(self, language: str, opts: ASROptions) -> None:
        self._language = language
        self._opts = opts
        self._ws = await self._dial_and_handshake()
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
        self._closing = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(OSError, ConnectionError):
                await ws.send(json.dumps({"type": "close"}))
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

    async def _dial_and_handshake(self) -> MessageStream:
        delay = self._redial_base_delay_s
        for attempt in range(self._max_redials + 1):
            try:
                ws = await self._dial()
                await ws.send(
                    json.dumps(
                        {
                            "type": "open",
                            "language": self._language,
                            "sample_rate": self._opts.sample_rate,
                            "keyterms": list(self._opts.keyterms),
                        }
                    )
                )
                while True:
                    raw = await ws.recv()
                    if raw is None:
                        raise AsrStreamError("asr server closed during handshake")
                    if isinstance(raw, bytes):
                        continue
                    message = json.loads(raw)
                    if message.get("type") == "ready":
                        return ws
                    if message.get("type") == "error":
                        raise AsrStreamError(str(message.get("detail")))
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
            self._ws = await self._dial_and_handshake()
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
            if kind == "result":
                self._queue.put_nowait(self._parse_result(message))
            elif kind == "error":
                self._error = AsrStreamError(str(message.get("detail")))
                break
            # pong and unknown messages only refresh _last_rx_ms
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
                await ws.send(json.dumps({"type": "ping", "ts": monotonic_ms()}))
            if monotonic_ms() - self._last_rx_ms > self._heartbeat_timeout_s * 1000.0:
                with contextlib.suppress(AsrStreamError):
                    await self._reconnect(generation)

    def _parse_result(self, message: Any) -> ASRResult:
        words = tuple(
            Word(
                text=str(word["text"]),
                start_ms=float(word["start_ms"]),
                end_ms=float(word["end_ms"]),
                confidence=None if word.get("confidence") is None else float(word["confidence"]),
            )
            for word in message.get("words") or ()
        )
        return ASRResult(
            text=str(message["text"]),
            is_final=bool(message["final"]),
            confidence=None if message.get("confidence") is None else float(message["confidence"]),
            words=words,
            received_at=monotonic_ms(),
        )
