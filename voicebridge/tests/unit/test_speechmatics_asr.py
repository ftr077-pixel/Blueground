"""SpeechmaticsASR tests: StartRecognition handshake, transcript parsing for
Hebrew, and the resilience cases required for every streaming vendor."""

import asyncio
import json
from typing import Any

import pytest

from app.providers.asr.speechmatics import (
    AsrStreamError,
    SpeechmaticsASR,
    SpeechmaticsConfig,
)
from app.providers.base import ASROptions, ASRResult
from tests.support.fakes import speech_frame, wait_until

CONFIG = SpeechmaticsConfig(api_key="k")


def transcript_message(text: str, is_final: bool, words: list[str] | None = None) -> str:
    results: list[dict[str, Any]] = []
    for i, word in enumerate(words or text.split()):
        results.append(
            {
                "type": "word",
                "start_time": i * 0.3,
                "end_time": i * 0.3 + 0.25,
                "alternatives": [{"content": word, "confidence": 0.9}],
            }
        )
    results.append(
        {
            "type": "punctuation",
            "start_time": 1.0,
            "end_time": 1.0,
            "alternatives": [{"content": ".", "confidence": 1.0}],
        }
    )
    return json.dumps(
        {
            "message": "AddTranscript" if is_final else "AddPartialTranscript",
            "metadata": {"transcript": text},
            "results": results,
        }
    )


class FakeSmSocket:
    def __init__(self, auto_start: bool = True) -> None:
        self.to_client: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False
        self._auto_start = auto_start

    async def recv(self) -> str | bytes | None:
        return await self.to_client.get()

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)
        if isinstance(data, str) and self._auto_start:
            message = json.loads(data)
            if message.get("message") == "StartRecognition":
                self.to_client.put_nowait(
                    json.dumps({"message": "RecognitionStarted", "id": "abc"})
                )

    async def close(self) -> None:
        self.closed = True
        self.to_client.put_nowait(None)

    def die(self) -> None:
        self.to_client.put_nowait(None)

    def push(self, raw: str) -> None:
        self.to_client.put_nowait(raw)

    def json_sent(self) -> list[dict[str, Any]]:
        return [json.loads(str(m)) for m in self.sent if isinstance(m, str)]


class FakeDialer:
    def __init__(self, auto_start: bool = True, fail_first: int = 0) -> None:
        self.sockets: list[FakeSmSocket] = []
        self._auto_start = auto_start
        self._fail_first = fail_first

    async def __call__(self) -> FakeSmSocket:
        if self._fail_first > 0:
            self._fail_first -= 1
            raise ConnectionError("dial refused")
        socket = FakeSmSocket(auto_start=self._auto_start)
        self.sockets.append(socket)
        return socket


def make_client(
    dialer: FakeDialer,
    *,
    heartbeat_interval_s: float = 5.0,
    heartbeat_timeout_s: float = 10.0,
    max_redials: int = 3,
) -> SpeechmaticsASR:
    return SpeechmaticsASR(
        dialer,
        CONFIG,
        heartbeat_interval_s=heartbeat_interval_s,
        heartbeat_timeout_s=heartbeat_timeout_s,
        max_redials=max_redials,
        redial_base_delay_s=0.01,
    )


async def collect(client: SpeechmaticsASR, n: int, timeout_s: float = 2.0) -> list[ASRResult]:
    async def take() -> list[ASRResult]:
        out: list[ASRResult] = []
        async for result in client.results():
            out.append(result)
            if len(out) == n:
                break
        return out

    return await asyncio.wait_for(take(), timeout_s)


class TestConfig:
    def test_start_message_declares_internal_format_and_partials(self) -> None:
        message = CONFIG.start_message("he", ASROptions(keyterms=("Blueground",)))
        assert message["message"] == "StartRecognition"
        assert message["audio_format"] == {
            "type": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": 16000,
        }
        config = message["transcription_config"]
        assert isinstance(config, dict)
        assert config["language"] == "he"
        assert config["enable_partials"] is True
        assert config["additional_vocab"] == [{"content": "Blueground"}]

    def test_auth_header_and_env(self) -> None:
        assert CONFIG.auth_headers() == {"Authorization": "Bearer k"}
        with pytest.raises(RuntimeError, match="SPEECHMATICS_API_KEY"):
            SpeechmaticsConfig.from_env({})
        assert SpeechmaticsConfig.from_env({"SPEECHMATICS_API_KEY": "k"}).max_delay_s == 3.0
        override = SpeechmaticsConfig.from_env(
            {"SPEECHMATICS_API_KEY": "k", "SPEECHMATICS_MAX_DELAY_S": "1.5"}
        )
        assert override.max_delay_s == 1.5


class TestProtocol:
    async def test_handshake_then_hebrew_partial_and_final(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        assert dialer.sockets[0].json_sent()[0]["message"] == "StartRecognition"

        dialer.sockets[0].push(transcript_message("שלום", is_final=False))
        dialer.sockets[0].push(transcript_message("שלום חבר", is_final=True))
        results = await collect(client, 2)
        assert [r.text for r in results] == ["שלום", "שלום חבר"]
        assert [r.is_final for r in results] == [False, True]
        assert results[1].confidence == pytest.approx(0.9)
        # Punctuation entries are not words.
        assert [w.text for w in results[1].words] == ["שלום", "חבר"]
        assert results[1].words[1].start_ms == pytest.approx(300.0)
        await client.close()

    async def test_empty_transcript_is_dropped(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("   ", is_final=False, words=[]))
        dialer.sockets[0].push(json.dumps({"message": "AudioAdded", "seq_no": 3}))
        dialer.sockets[0].push(transcript_message("יש דיבור", is_final=True))
        results = await collect(client, 1)
        assert results[0].text == "יש דיבור"
        await client.close()

    async def test_push_sends_audio_and_close_sends_end_of_stream(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        await client.push(speech_frame(0.0))
        await client.push(speech_frame(20.0))
        assert dialer.sockets[0].sent[-1] == speech_frame(20.0).pcm
        await client.close()
        assert dialer.sockets[0].json_sent()[-1] == {"message": "EndOfStream", "last_seq_no": 2}

    async def test_non_internal_sample_rate_is_rejected(self) -> None:
        client = make_client(FakeDialer())
        with pytest.raises(ValueError, match="16000"):
            await client.open("he", ASROptions(sample_rate=8000))

    async def test_vendor_error_surfaces_through_results(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(
            json.dumps({"message": "Error", "type": "quota_exceeded", "reason": "no quota left"})
        )
        with pytest.raises(AsrStreamError, match="no quota left"):
            async for _ in client.results():
                pass


class TestResilience:
    async def test_socket_killed_mid_utterance_restarts_recognition(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("תחילת משפט", is_final=False))
        dialer.sockets[0].die()
        await wait_until(lambda: len(dialer.sockets) == 2)
        assert dialer.sockets[1].json_sent()[0]["message"] == "StartRecognition"
        dialer.sockets[1].push(transcript_message("המשך משפט", is_final=True))
        results = await collect(client, 2)
        assert results[1].text == "המשך משפט"
        await client.close()

    async def test_silent_socket_is_replaced_on_receive_timeout(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer, heartbeat_interval_s=0.02, heartbeat_timeout_s=0.05)
        await client.open("he", ASROptions())
        await wait_until(lambda: len(dialer.sockets) >= 2)
        assert dialer.sockets[0].closed
        dialer.sockets[-1].push(transcript_message("אחרי החלפה", is_final=True))
        results = await collect(client, 1)
        assert results[0].text == "אחרי החלפה"
        await client.close()

    async def test_dial_retries_then_gives_up(self) -> None:
        recovers = FakeDialer(fail_first=2)
        client = make_client(recovers)
        await client.open("he", ASROptions())
        assert len(recovers.sockets) == 1
        await client.close()

        never_up = FakeDialer(fail_first=10)
        failing = make_client(never_up, max_redials=2)
        with pytest.raises(AsrStreamError, match="after 3 attempts"):
            await failing.open("he", ASROptions())
