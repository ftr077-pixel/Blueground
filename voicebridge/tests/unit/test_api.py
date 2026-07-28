"""API-layer tests: TwiML shape, operator pairing, and the event feed's
promise that it never blocks the pipeline."""

import asyncio
import json

from app.api.feed import MAX_PENDING, OperatorFeed
from app.api.pool import OperatorPool
from app.api.twiml import connect_stream, media_stream_url, reject
from app.observability.events import EventBus
from app.transport import MessageStream


class DummySocket:
    async def recv(self) -> str | bytes | None:
        return None

    async def send(self, data: str | bytes) -> None:
        return None

    async def close(self) -> None:
        return None


def socket() -> MessageStream:
    return DummySocket()


class TestTwiml:
    def test_connect_stream_is_valid_xml_with_quoted_url(self) -> None:
        xml = connect_stream("wss://host.example.com/ws/twilio?a=1&b=2")
        assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?>')
        assert "<Connect>" in xml and "</Connect>" in xml
        assert "&amp;" in xml  # the ampersand must be escaped, not raw
        assert "<Stream " in xml

    def test_reject_says_and_hangs_up(self) -> None:
        xml = reject("No operator <right now>")
        assert "<Hangup />" in xml
        assert "&lt;right now&gt;" in xml

    def test_media_stream_url_upgrades_scheme(self) -> None:
        assert media_stream_url("https://x.example.com") == "wss://x.example.com/ws/twilio"
        assert media_stream_url("https://x.example.com/") == "wss://x.example.com/ws/twilio"
        assert media_stream_url("x.example.com") == "wss://x.example.com/ws/twilio"
        assert media_stream_url("http://localhost:8080") == "ws://localhost:8080/ws/twilio"


class TestOperatorPool:
    def test_claim_is_first_in_first_out(self) -> None:
        pool = OperatorPool()
        first = pool.register(socket())
        second = pool.register(socket())
        assert pool.available == 2
        assert pool.claim() is first
        assert pool.claim() is second
        assert pool.claim() is None

    def test_claiming_marks_the_operator(self) -> None:
        pool = OperatorPool()
        operator = pool.register(socket())
        assert not operator.claimed.is_set()
        pool.claim()
        assert operator.claimed.is_set()

    def test_disconnected_operators_are_skipped(self) -> None:
        pool = OperatorPool()
        gone = pool.register(socket())
        live = pool.register(socket())
        pool.drop(gone)
        assert pool.available == 1
        assert pool.claim() is live

    def test_drop_releases_a_claimed_operator(self) -> None:
        pool = OperatorPool()
        operator = pool.register(socket())
        pool.claim()
        pool.drop(operator)
        assert operator.released.is_set()
        assert pool.available == 0


class TestOperatorFeed:
    def test_only_interesting_events_are_forwarded(self) -> None:
        feed = OperatorFeed()
        bus = EventBus("s1", (feed,))
        bus.emit("asr_partial", direction="a2b", text="שלום")
        bus.emit("tts_first_audio", direction="a2b")  # not forwarded
        bus.emit("mt_completed", direction="a2b", translated_text="Hello")
        lines = [feed.queue.get_nowait() for _ in range(feed.queue.qsize())]
        names = [json.loads(line)["name"] for line in lines if line is not None]
        assert names == ["asr_partial", "mt_completed"]

    def test_a_stalled_console_never_blocks_emission(self) -> None:
        feed = OperatorFeed()
        bus = EventBus("s1", (feed,))
        for i in range(MAX_PENDING + 50):
            bus.emit("asr_partial", direction="a2b", text=f"line {i}")
        assert feed.queue.qsize() <= MAX_PENDING
        # The newest line survives; the oldest were dropped.
        lines = [line for _ in range(feed.queue.qsize()) if (line := feed.queue.get_nowait())]
        assert json.loads(lines[-1])["text"] == f"line {MAX_PENDING + 49}"

    async def test_stop_ends_the_pump(self) -> None:
        feed = OperatorFeed()
        feed.stop()
        assert await asyncio.wait_for(feed.queue.get(), 1.0) is None
