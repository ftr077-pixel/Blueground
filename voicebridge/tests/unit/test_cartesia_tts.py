"""CartesiaTTS tests: streaming request shape, first chunk before completion,
and cancellation — the ADR-006 load-bearing case, including that cancel stops
local playback without waiting for the vendor."""

import asyncio
import base64
import json
from collections.abc import AsyncIterator

import pytest

from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.providers.base import VoiceSpec
from app.providers.tts.cartesia import CartesiaConfig, CartesiaTTS, TtsStreamError
from tests.support.fakes import wait_until

VOICE = VoiceSpec(voice_id="voice-en", language="en", sample_rate=INTERNAL_SAMPLE_RATE)
CONFIG = CartesiaConfig(api_key="k", model_id="sonic-2")
CHUNK_PCM = b"\x10\x00" * 160


class FakeCartesiaSocket:
    def __init__(self) -> None:
        self.to_client: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False

    async def recv(self) -> str | bytes | None:
        return await self.to_client.get()

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True
        self.to_client.put_nowait(None)

    # --- vendor-side helpers ------------------------------------------------

    def chunk(self, context_id: str, pcm: bytes = CHUNK_PCM) -> None:
        self.to_client.put_nowait(
            json.dumps(
                {
                    "type": "chunk",
                    "context_id": context_id,
                    "data": base64.b64encode(pcm).decode("ascii"),
                }
            )
        )

    def done(self, context_id: str) -> None:
        self.to_client.put_nowait(json.dumps({"type": "done", "context_id": context_id}))

    def error(self, context_id: str, detail: str) -> None:
        self.to_client.put_nowait(
            json.dumps({"type": "error", "context_id": context_id, "error": detail})
        )

    def requests(self) -> list[dict[str, object]]:
        return [json.loads(str(m)) for m in self.sent]


async def make_tts() -> tuple[CartesiaTTS, FakeCartesiaSocket]:
    socket = FakeCartesiaSocket()

    async def dial() -> FakeCartesiaSocket:
        return socket

    tts = CartesiaTTS(dial, CONFIG)
    await tts.start()
    return tts, socket


async def drain(frames: AsyncIterator[AudioFrame], out: list[AudioFrame]) -> None:
    async for frame in frames:
        out.append(frame)


def test_stream_url_carries_key_and_version() -> None:
    url = CONFIG.stream_url()
    assert url.startswith("wss://api.cartesia.ai/tts/websocket?")
    assert "api_key=k" in url
    assert "cartesia_version=" in url


def test_from_env_requires_a_key() -> None:
    with pytest.raises(RuntimeError, match="CARTESIA_API_KEY"):
        CartesiaConfig.from_env({})
    assert CartesiaConfig.from_env({"CARTESIA_API_KEY": "k"}).model_id == "sonic-2"


async def test_synthesis_requests_internal_format_and_streams_frames() -> None:
    tts, socket = await make_tts()
    synthesis = tts.synthesize("Hello friend", VOICE)
    collected: list[AudioFrame] = []
    task = asyncio.create_task(drain(synthesis.frames, collected))

    await wait_until(lambda: socket.sent != [])
    request = socket.requests()[0]
    assert request["transcript"] == "Hello friend"
    assert request["context_id"] == synthesis.handle.id
    assert request["output_format"] == {
        "container": "raw",
        "encoding": "pcm_s16le",
        "sample_rate": 16000,
    }
    assert request["voice"] == {"mode": "id", "id": "voice-en"}

    socket.chunk(synthesis.handle.id)
    # First chunk must be deliverable before synthesis completes.
    await wait_until(lambda: len(collected) == 1)
    assert collected[0].sample_rate == INTERNAL_SAMPLE_RATE
    assert collected[0].pcm == CHUNK_PCM

    socket.chunk(synthesis.handle.id)
    socket.done(synthesis.handle.id)
    await asyncio.wait_for(task, timeout=2.0)
    assert len(collected) == 2
    await tts.close()


async def test_cancel_ends_the_stream_and_tells_the_vendor() -> None:
    tts, socket = await make_tts()
    synthesis = tts.synthesize("A very long sentence", VOICE)
    collected: list[AudioFrame] = []
    task = asyncio.create_task(drain(synthesis.frames, collected))
    await wait_until(lambda: socket.sent != [])
    socket.chunk(synthesis.handle.id)
    await wait_until(lambda: len(collected) == 1)

    await tts.cancel(synthesis.handle)
    await asyncio.wait_for(task, timeout=2.0)

    cancel_message = socket.requests()[-1]
    assert cancel_message == {"context_id": synthesis.handle.id, "cancel": True}
    # Chunks that were already in flight must not reach playback.
    socket.chunk(synthesis.handle.id)
    await asyncio.sleep(0.02)
    assert len(collected) == 1
    await tts.close()


async def test_cancel_does_not_wait_for_the_vendor() -> None:
    # A vendor that never answers must not hold playback: the local stream
    # ends on cancel regardless.
    socket = FakeCartesiaSocket()
    slow_send = asyncio.Event()

    class SlowSocket(FakeCartesiaSocket):
        async def send(self, data: str | bytes) -> None:
            self.sent.append(data)
            if isinstance(data, str) and json.loads(data).get("cancel"):
                await slow_send.wait()

    slow = SlowSocket()

    async def dial() -> FakeCartesiaSocket:
        return slow

    tts = CartesiaTTS(dial, CONFIG)
    await tts.start()
    synthesis = tts.synthesize("text", VOICE)
    collected: list[AudioFrame] = []
    task = asyncio.create_task(drain(synthesis.frames, collected))
    await wait_until(lambda: slow.sent != [])
    cancel_task = asyncio.create_task(tts.cancel(synthesis.handle))
    await asyncio.wait_for(task, timeout=1.0)  # stream ended while cancel is blocked
    slow_send.set()
    await cancel_task
    await tts.close()
    assert socket.sent == []


async def test_vendor_error_raises_from_the_stream() -> None:
    tts, socket = await make_tts()
    synthesis = tts.synthesize("text", VOICE)
    collected: list[AudioFrame] = []
    task = asyncio.create_task(drain(synthesis.frames, collected))
    await wait_until(lambda: socket.sent != [])
    socket.error(synthesis.handle.id, "voice not found")
    with pytest.raises(TtsStreamError, match="voice not found"):
        await asyncio.wait_for(task, timeout=2.0)
    await tts.close()


async def test_two_utterances_are_multiplexed_by_context() -> None:
    tts, socket = await make_tts()
    first = tts.synthesize("first", VOICE)
    second = tts.synthesize("second", VOICE)
    assert first.handle.id != second.handle.id
    got_first: list[AudioFrame] = []
    got_second: list[AudioFrame] = []
    task_a = asyncio.create_task(drain(first.frames, got_first))
    task_b = asyncio.create_task(drain(second.frames, got_second))
    await wait_until(lambda: len(socket.sent) == 2)

    socket.chunk(second.handle.id, b"\x20\x00" * 160)
    socket.done(second.handle.id)
    await asyncio.wait_for(task_b, timeout=2.0)
    assert got_first == []

    socket.chunk(first.handle.id, CHUNK_PCM)
    socket.done(first.handle.id)
    await asyncio.wait_for(task_a, timeout=2.0)
    assert got_first[0].pcm == CHUNK_PCM
    await tts.close()


async def test_non_internal_voice_rate_is_rejected() -> None:
    tts, _ = await make_tts()
    with pytest.raises(ValueError, match="16000"):
        tts.synthesize("text", VoiceSpec(voice_id="v", language="en", sample_rate=24000))
    await tts.close()
