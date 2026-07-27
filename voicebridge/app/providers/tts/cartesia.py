"""Cartesia streaming TTS client (ADR-003).

Wire protocol, as used here — one WebSocket per session, utterances
multiplexed by ``context_id``:

    client -> vendor:  {"model_id": ..., "transcript": ..., "voice": {...},
                        "output_format": {...}, "context_id": ..., "continue": false}
                       {"context_id": ..., "cancel": true}
    vendor -> client:  {"type": "chunk", "context_id": ..., "data": "<base64>"}
                       {"type": "done",  "context_id": ...}
                       {"type": "error", "context_id": ..., "error": "..."}

Audio is requested as raw pcm_s16le at 16 kHz so it needs no conversion
(ADR-002): what arrives is already the internal format.

Cancellation is the load-bearing requirement (ADR-006): barge-in is
impossible without it, so ``cancel`` both tells the vendor to stop billing
and generating *and* immediately ends the local frame stream — the duplex
controller must not wait for a vendor round trip to stop playing.

UNVERIFIED against the live API: the message shapes above are implemented
from the documented protocol and exercised against a fake. Confirm on the
first real call before trusting the M0 numbers.
"""

import asyncio
import base64
import contextlib
import json
import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.observability.events import monotonic_ms
from app.providers.base import Synthesis, SynthesisHandle, VoiceSpec
from app.transport import MessageStream

Dialer = Callable[[], Awaitable[MessageStream]]

DEFAULT_ENDPOINT = "wss://api.cartesia.ai/tts/websocket"
DEFAULT_VERSION = "2024-06-10"


class TtsStreamError(ConnectionError):
    pass


@dataclass(frozen=True, slots=True)
class CartesiaConfig:
    api_key: str
    model_id: str = "sonic-2"
    endpoint: str = DEFAULT_ENDPOINT
    version: str = DEFAULT_VERSION

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "CartesiaConfig":
        e = os.environ if env is None else env
        api_key = e.get("CARTESIA_API_KEY")
        if not api_key:
            raise RuntimeError("CARTESIA_API_KEY must be set")
        return cls(
            api_key=api_key,
            model_id=e.get("CARTESIA_MODEL", "sonic-2"),
            endpoint=e.get("CARTESIA_ENDPOINT", DEFAULT_ENDPOINT),
            version=e.get("CARTESIA_VERSION", DEFAULT_VERSION),
        )

    def stream_url(self) -> str:
        return f"{self.endpoint}?api_key={self.api_key}&cartesia_version={self.version}"


@dataclass(slots=True)
class _Context:
    queue: asyncio.Queue[AudioFrame | None] = field(default_factory=asyncio.Queue)
    cancelled: bool = False
    error: str | None = None


class CartesiaTTS:
    def __init__(self, dial: Dialer, config: CartesiaConfig) -> None:
        self._dial = dial
        self._config = config
        self._ws: MessageStream | None = None
        self._contexts: dict[str, _Context] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._closing = False

    # --- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        self._ws = await self._dial()
        self._reader_task = asyncio.create_task(self._reader())

    async def close(self) -> None:
        self._closing = True
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(OSError, ConnectionError):
                await ws.close()
        if self._reader_task is not None:
            try:
                await asyncio.wait_for(self._reader_task, timeout=1.0)
            except TimeoutError:
                self._reader_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._reader_task
        for context in self._contexts.values():
            context.queue.put_nowait(None)

    # --- TTSProvider --------------------------------------------------------

    def synthesize(self, text: str, voice: VoiceSpec) -> Synthesis:
        if voice.sample_rate != INTERNAL_SAMPLE_RATE:
            raise ValueError(f"expected {INTERNAL_SAMPLE_RATE} Hz voice, got {voice.sample_rate}")
        context_id = uuid.uuid4().hex
        self._contexts[context_id] = _Context()
        return Synthesis(
            handle=SynthesisHandle(id=context_id),
            frames=self._stream(context_id, text, voice),
        )

    async def cancel(self, handle: SynthesisHandle) -> None:
        context = self._contexts.get(handle.id)
        if context is None or context.cancelled:
            return
        context.cancelled = True
        # End the local stream first: playback must stop now, not after the
        # vendor acknowledges (ADR-006's 300 ms barge-in budget).
        context.queue.put_nowait(None)
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(OSError, ConnectionError):
                await ws.send(json.dumps({"context_id": handle.id, "cancel": True}))

    # --- internals ----------------------------------------------------------

    async def _stream(
        self, context_id: str, text: str, voice: VoiceSpec
    ) -> AsyncIterator[AudioFrame]:
        context = self._contexts[context_id]
        try:
            if not context.cancelled:
                await self._require_ws().send(
                    json.dumps(
                        {
                            "model_id": self._config.model_id,
                            "transcript": text,
                            "voice": {"mode": "id", "id": voice.voice_id},
                            "language": voice.language,
                            "output_format": {
                                "container": "raw",
                                "encoding": "pcm_s16le",
                                "sample_rate": voice.sample_rate,
                            },
                            "context_id": context_id,
                            "continue": False,
                        }
                    )
                )
            while True:
                frame = await context.queue.get()
                if frame is None:
                    break
                yield frame
            if context.error is not None and not context.cancelled:
                raise TtsStreamError(context.error)
        finally:
            self._contexts.pop(context_id, None)

    def _require_ws(self) -> MessageStream:
        if self._ws is None:
            raise TtsStreamError("tts stream is not open")
        return self._ws

    async def _reader(self) -> None:
        while not self._closing:
            try:
                raw = await self._require_ws().recv()
            except (OSError, ConnectionError):
                raw = None
            if raw is None:
                break
            if isinstance(raw, bytes):
                continue
            message = json.loads(raw)
            context_id = str(message.get("context_id") or "")
            context = self._contexts.get(context_id)
            if context is None:
                # Late chunks for a cancelled utterance; nothing to play them into.
                continue
            kind = message.get("type")
            if kind == "chunk":
                if context.cancelled:
                    continue
                pcm = base64.b64decode(str(message["data"]))
                if pcm:
                    context.queue.put_nowait(
                        AudioFrame(pcm=pcm, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=monotonic_ms())
                    )
            elif kind == "done":
                context.queue.put_nowait(None)
            elif kind == "error":
                context.error = str(message.get("error") or "tts error")
                context.queue.put_nowait(None)
        for context in self._contexts.values():
            context.queue.put_nowait(None)
