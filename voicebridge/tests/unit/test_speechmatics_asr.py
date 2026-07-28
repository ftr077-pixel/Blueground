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
    def __init__(self, auto_start: bool = True, reject_with: str | None = None) -> None:
        self.to_client: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False
        self._auto_start = auto_start
        self._reject_with = reject_with

    async def recv(self) -> str | bytes | None:
        return await self.to_client.get()

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)
        if isinstance(data, str) and self._auto_start:
            message = json.loads(data)
            if message.get("message") != "StartRecognition":
                return
            if self._reject_with is not None:
                self.to_client.put_nowait(
                    json.dumps({"message": "Error", "type": "quota", "reason": self._reject_with})
                )
                return
            self.to_client.put_nowait(json.dumps({"message": "RecognitionStarted", "id": "abc"}))

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
    def __init__(
        self,
        auto_start: bool = True,
        fail_first: int = 0,
        reject_with: str | None = None,
    ) -> None:
        self.sockets: list[FakeSmSocket] = []
        self._auto_start = auto_start
        self._fail_first = fail_first
        self._reject_with = reject_with

    async def __call__(self) -> FakeSmSocket:
        if self._fail_first > 0:
            self._fail_first -= 1
            raise ConnectionError("dial refused")
        socket = FakeSmSocket(auto_start=self._auto_start, reject_with=self._reject_with)
        self.sockets.append(socket)
        return socket


class DeadHandshakeDialer(FakeDialer):
    """The vendor accepts the socket then hangs up before RecognitionStarted."""

    async def __call__(self) -> FakeSmSocket:
        socket = FakeSmSocket(auto_start=False)
        socket.to_client.put_nowait(None)
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
        # Inside transcription_config: at the top level the vendor rejects the
        # whole StartRecognition message.
        assert config["conversation_config"] == {"end_of_utterance_silence_trigger": 0.6}
        assert "conversation_config" not in message

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
    async def test_partials_and_chunks_report_the_running_utterance(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        assert dialer.sockets[0].json_sent()[0]["message"] == "StartRecognition"

        dialer.sockets[0].push(transcript_message("שלום", is_final=False))
        dialer.sockets[0].push(transcript_message("שלום חבר", is_final=True))
        results = await collect(client, 2)
        assert [r.text for r in results] == ["שלום", "שלום חבר"]
        # A finalised chunk is not the end of an utterance.
        assert [r.is_final for r in results] == [False, False]
        await client.close()

    async def test_incremental_chunks_accumulate_instead_of_repeating(self) -> None:
        # Measured on a live call: "אני רוצה להזמין חדר" arrives as four
        # separate finals. Reporting each on its own made the segmenter
        # commit the sentence twice and the caller heard it twice.
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        for word in ("אני", "רוצה", "להזמין", "חדר"):
            dialer.sockets[0].push(transcript_message(word, is_final=True))
        results = await collect(client, 4)
        assert [r.text for r in results] == [
            "אני",
            "אני רוצה",
            "אני רוצה להזמין",
            "אני רוצה להזמין חדר",
        ]
        assert not any(r.is_final for r in results)
        await client.close()

    async def test_end_of_utterance_finalises_the_accumulated_text(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("אני", is_final=True))
        dialer.sockets[0].push(transcript_message("רוצה", is_final=True))
        dialer.sockets[0].push(json.dumps({"message": "EndOfUtterance"}))
        results = await collect(client, 3)
        assert results[-1].text == "אני רוצה"
        assert results[-1].is_final is True
        # The next utterance starts empty rather than repeating the last one.
        dialer.sockets[0].push(transcript_message("שלום", is_final=True))
        more = await collect(client, 1)
        assert more[0].text == "שלום"
        await client.close()

    async def test_a_settled_buffer_closes_without_end_of_utterance(self) -> None:
        dialer = FakeDialer()
        client = SpeechmaticsASR(
            dialer,
            SpeechmaticsConfig(api_key="k", utterance_end_silence_s=0.05, max_delay_s=0.05),
            heartbeat_interval_s=0.05,
            heartbeat_timeout_s=30.0,
            max_redials=0,
            redial_base_delay_s=0.01,
        )
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("שלום", is_final=True))
        results = await collect(client, 2, timeout_s=3.0)
        assert results[-1].is_final is True
        assert results[-1].text == "שלום"
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


class TestStreamLeaks:
    """A socket left open after a failed handshake still counts against the
    account's concurrent-stream limit. Measured on the box: after the first
    rejection every later call died with 'Concurrent Quota Exceeded' too,
    because each failure leaked one socket per redial attempt."""

    async def test_a_vendor_rejection_closes_the_socket_and_does_not_redial(self) -> None:
        dialer = FakeDialer(reject_with="Concurrent Quota Exceeded")
        client = make_client(dialer, max_redials=3)
        with pytest.raises(AsrStreamError, match="Concurrent Quota Exceeded"):
            await client.open("he", ASROptions())
        # The vendor answered; redialling cannot change its answer and each
        # attempt would hold another stream.
        assert len(dialer.sockets) == 1
        assert dialer.sockets[0].closed

    async def test_a_handshake_that_dies_closes_each_socket_before_retrying(self) -> None:
        dialer = DeadHandshakeDialer()
        client = make_client(dialer, max_redials=2)
        with pytest.raises(AsrStreamError, match="after 3 attempts"):
            await client.open("he", ASROptions())
        assert len(dialer.sockets) == 3
        assert all(socket.closed for socket in dialer.sockets)

    async def test_close_is_idempotent(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        await client.close()
        await client.close()
        assert dialer.sockets[0].closed


class TestUtteranceBoundaries:
    """Measured on a live call: sentences were cut into pieces and each piece
    translated on its own, then the pieces overlapped. Both come from the
    local utterance-end fallback firing between the chunks of one sentence."""

    def test_the_settle_timeout_outlasts_the_vendors_chunk_cadence(self) -> None:
        config = SpeechmaticsConfig(api_key="k", max_delay_s=3.0, utterance_end_silence_s=0.6)
        # A finalised chunk may legitimately be max_delay behind the speech,
        # so anything shorter cuts a sentence at every chunk boundary.
        assert config.settle_timeout_ms > config.max_delay_s * 1000.0

    async def test_a_partial_only_utterance_still_reports_its_end(self) -> None:
        """The segmenter learns an utterance ended only from is_final. If the
        vendor ends one before finalising any chunk, staying silent leaves the
        segmenter anchored to the previous sentence and it re-emits text it
        already committed."""
        dialer = FakeDialer()
        client = SpeechmaticsASR(
            dialer,
            SpeechmaticsConfig(api_key="k", utterance_end_silence_s=0.05, max_delay_s=0.05),
            heartbeat_interval_s=0.05,
            heartbeat_timeout_s=30.0,
            max_redials=0,
            redial_base_delay_s=0.01,
        )
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("שלום חבר", is_final=False))
        results = await collect(client, 2, timeout_s=3.0)
        assert results[0].is_final is False
        assert results[-1].is_final is True
        assert results[-1].text == "שלום חבר"
        await client.close()

    async def test_end_of_utterance_reports_a_partial_only_utterance(self) -> None:
        dialer = FakeDialer()
        client = make_client(dialer)
        await client.open("he", ASROptions())
        dialer.sockets[0].push(transcript_message("רק חלקי", is_final=False))
        dialer.sockets[0].push(json.dumps({"message": "EndOfUtterance"}))
        results = await collect(client, 2)
        assert results[-1].is_final is True
        assert results[-1].text == "רק חלקי"
        await client.close()
