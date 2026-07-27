"""DeepgramASR tests: protocol parsing, URL/auth construction, and the
CLAUDE.md-mandated resilience cases — socket killed mid-utterance, silently
dead socket caught by heartbeat, dial retries with a cap."""

import asyncio
import json

import pytest

from app.providers.asr.deepgram import AsrStreamError, DeepgramASR, DeepgramConfig
from app.providers.base import ASROptions, ASRResult
from tests.support.fakes import speech_frame, wait_until


def results_message(text: str, is_final: bool = False) -> str:
    alternative: dict[str, object] = {"transcript": text, "confidence": 0.93}
    if text:
        first = text.split()[0]
        alternative["words"] = [
            {
                "word": first,
                "punctuated_word": f"{first},",
                "start": 0.0,
                "end": 0.12,
                "confidence": 0.91,
            }
        ]
    return json.dumps(
        {"type": "Results", "is_final": is_final, "channel": {"alternatives": [alternative]}}
    )


class FakeDeepgramSocket:
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

    def die(self) -> None:
        self.to_client.put_nowait(None)

    def push(self, raw: str) -> None:
        self.to_client.put_nowait(raw)


class FakeDialer:
    def __init__(self, fail_first: int = 0) -> None:
        self.sockets: list[FakeDeepgramSocket] = []
        self._fail_first = fail_first

    async def __call__(self) -> FakeDeepgramSocket:
        if self._fail_first > 0:
            self._fail_first -= 1
            raise ConnectionError("dial refused")
        socket = FakeDeepgramSocket()
        self.sockets.append(socket)
        return socket


def make_client(
    dialer: FakeDialer,
    *,
    heartbeat_interval_s: float = 5.0,
    heartbeat_timeout_s: float = 10.0,
    max_redials: int = 3,
) -> DeepgramASR:
    return DeepgramASR(
        dialer,
        heartbeat_interval_s=heartbeat_interval_s,
        heartbeat_timeout_s=heartbeat_timeout_s,
        max_redials=max_redials,
        redial_base_delay_s=0.01,
    )


async def collect(client: DeepgramASR, n: int, timeout_s: float = 2.0) -> list[ASRResult]:
    async def take() -> list[ASRResult]:
        out: list[ASRResult] = []
        async for result in client.results():
            out.append(result)
            if len(out) == n:
                break
        return out

    return await asyncio.wait_for(take(), timeout_s)


class TestConfig:
    def test_stream_url_carries_internal_format_and_keyterms(self) -> None:
        config = DeepgramConfig(api_key="k", model="nova-3")
        url = config.stream_url("he", ASROptions(keyterms=("Blueground",)))
        assert url.startswith("wss://api.deepgram.com/v1/listen?")
        assert "encoding=linear16" in url
        assert "sample_rate=16000" in url
        assert "language=he" in url
        assert "interim_results=true" in url
        assert "keyterm=Blueground" in url

    def test_auth_header_shape(self) -> None:
        assert DeepgramConfig(api_key="secret").auth_headers() == {"Authorization": "Token secret"}

    def test_from_env_requires_a_key(self) -> None:
        with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY"):
            DeepgramConfig.from_env({})
        assert DeepgramConfig.from_env({"DEEPGRAM_API_KEY": "k"}).model == "nova-3"


class TestProtocol:
    async def test_partial_and_final_results_are_parsed(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("en", ASROptions())
        dialer.sockets[0].push(results_message("hello", is_final=False))
        dialer.sockets[0].push(results_message("hello there", is_final=True))
        results = await collect(client, 2)
        assert [r.text for r in results] == ["hello", "hello there"]
        assert [r.is_final for r in results] == [False, True]
        assert results[0].confidence == 0.93
        assert results[0].words[0].end_ms == 120.0
        assert results[0].words[0].text == "hello,"  # punctuated_word preferred
        assert all(r.received_at > 0 for r in results)
        await client.close()

    async def test_empty_transcripts_and_metadata_are_dropped(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("en", ASROptions())
        dialer.sockets[0].push(results_message("", is_final=False))
        dialer.sockets[0].push(json.dumps({"type": "Metadata", "request_id": "x"}))
        dialer.sockets[0].push(results_message("real speech", is_final=True))
        results = await collect(client, 1)
        assert results[0].text == "real speech"
        await client.close()

    async def test_push_sends_binary_audio_and_close_says_closestream(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("en", ASROptions())
        frame = speech_frame(0.0)
        await client.push(frame)
        assert dialer.sockets[0].sent[-1] == frame.pcm
        await client.close()
        assert json.loads(str(dialer.sockets[0].sent[-1])) == {"type": "CloseStream"}

    async def test_non_internal_sample_rate_is_rejected(self) -> None:
        client = make_client(FakeDialer())
        with pytest.raises(ValueError, match="16000"):
            await client.open("en", ASROptions(sample_rate=8000))

    async def test_vendor_error_surfaces_through_results(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("en", ASROptions())
        dialer.sockets[0].push(json.dumps({"type": "Error", "description": "quota exceeded"}))
        with pytest.raises(AsrStreamError, match="quota exceeded"):
            async for _ in client.results():
                pass


class TestResilience:
    async def test_socket_killed_mid_utterance_reconnects_and_continues(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(results_message("תחילת משפט"))
        dialer.sockets[0].die()
        await wait_until(lambda: len(dialer.sockets) == 2)
        dialer.sockets[1].push(results_message("המשך משפט", is_final=True))
        results = await collect(client, 2)
        assert results[1].text == "המשך משפט"
        await client.close()

    async def test_heartbeat_sends_keepalive(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer, heartbeat_interval_s=0.02, heartbeat_timeout_s=5.0)
        await client.open("en", ASROptions())
        await wait_until(
            lambda: any(
                isinstance(m, str) and json.loads(m).get("type") == "KeepAlive"
                for m in dialer.sockets[0].sent
            )
        )
        assert len(dialer.sockets) == 1
        await client.close()

    async def test_silently_dead_socket_is_replaced_by_heartbeat(self) -> None:
        # Nothing ever arrives: recv blocks forever. Only the receive-timeout
        # can notice; it must close the corpse and redial.
        dialer = FakeDialer()
        client = make_client(dialer, heartbeat_interval_s=0.02, heartbeat_timeout_s=0.05)
        await client.open("en", ASROptions())
        await wait_until(lambda: len(dialer.sockets) >= 2)
        assert dialer.sockets[0].closed
        dialer.sockets[-1].push(results_message("after swap", is_final=True))
        results = await collect(client, 1)
        assert results[0].text == "after swap"
        await client.close()

    async def test_dial_retries_then_gives_up(self) -> None:
        recovers = FakeDialer(fail_first=2)
        client = make_client(recovers)
        await client.open("en", ASROptions())
        assert len(recovers.sockets) == 1
        await client.close()

        never_up = FakeDialer(fail_first=10)
        failing = make_client(never_up, max_redials=2)
        with pytest.raises(AsrStreamError, match="after 3 attempts"):
            await failing.open("en", ASROptions())
