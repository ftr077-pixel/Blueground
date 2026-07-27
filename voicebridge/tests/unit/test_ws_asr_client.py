"""WsAsrClient tests: handshake, result parsing, and the CLAUDE.md-mandated
resilience cases — socket killed mid-utterance, silently dead socket caught
by heartbeat, dial retries with a cap."""

import asyncio
import json

import pytest

from app.providers.asr.ws_client import AsrStreamError, WsAsrClient
from app.providers.base import ASROptions, ASRResult
from tests.support.fakes import speech_frame, wait_until


class FakeAsrSocket:
    def __init__(self, auto_pong: bool = True) -> None:
        self.to_client: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False
        self._auto_pong = auto_pong

    async def recv(self) -> str | bytes | None:
        return await self.to_client.get()

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)
        if isinstance(data, str):
            message = json.loads(data)
            if message.get("type") == "open":
                self.to_client.put_nowait(json.dumps({"type": "ready"}))
            elif message.get("type") == "ping" and self._auto_pong:
                self.to_client.put_nowait(json.dumps({"type": "pong", "ts": message["ts"]}))

    async def close(self) -> None:
        self.closed = True
        self.to_client.put_nowait(None)

    def die(self) -> None:
        self.to_client.put_nowait(None)

    def push_result(self, text: str, final: bool = False) -> None:
        self.to_client.put_nowait(
            json.dumps(
                {
                    "type": "result",
                    "text": text,
                    "final": final,
                    "confidence": 0.9,
                    "words": [
                        {"text": text.split()[0], "start_ms": 0, "end_ms": 120, "confidence": 0.9}
                    ],
                }
            )
        )

    def push_error(self, detail: str) -> None:
        self.to_client.put_nowait(json.dumps({"type": "error", "detail": detail}))


class FakeDialer:
    def __init__(self, auto_pong: bool = True, fail_first: int = 0) -> None:
        self.sockets: list[FakeAsrSocket] = []
        self._auto_pong = auto_pong
        self._fail_first = fail_first

    async def __call__(self) -> FakeAsrSocket:
        if self._fail_first > 0:
            self._fail_first -= 1
            raise ConnectionError("dial refused")
        socket = FakeAsrSocket(auto_pong=self._auto_pong)
        self.sockets.append(socket)
        return socket


def make_client(
    dialer: FakeDialer,
    *,
    heartbeat_interval_s: float = 5.0,
    heartbeat_timeout_s: float = 10.0,
    max_redials: int = 3,
) -> WsAsrClient:
    return WsAsrClient(
        dialer,
        heartbeat_interval_s=heartbeat_interval_s,
        heartbeat_timeout_s=heartbeat_timeout_s,
        max_redials=max_redials,
        redial_base_delay_s=0.01,
    )


async def collect(client: WsAsrClient, n: int, timeout_s: float = 2.0) -> list[ASRResult]:
    async def take() -> list[ASRResult]:
        out: list[ASRResult] = []
        async for result in client.results():
            out.append(result)
            if len(out) == n:
                break
        return out

    return await asyncio.wait_for(take(), timeout_s)


async def test_open_handshake_and_result_parsing() -> None:
    dialer = FakeDialer()
    client = make_client(dialer)
    await client.open("he", ASROptions(keyterms=("Blueground",)))
    opened = json.loads(str(dialer.sockets[0].sent[0]))
    assert opened == {
        "type": "open",
        "language": "he",
        "sample_rate": 16000,
        "keyterms": ["Blueground"],
    }
    dialer.sockets[0].push_result("שלום", final=False)
    dialer.sockets[0].push_result("שלום חבר", final=True)
    results = await collect(client, 2)
    assert [r.text for r in results] == ["שלום", "שלום חבר"]
    assert [r.is_final for r in results] == [False, True]
    assert all(r.received_at > 0 for r in results)
    assert results[0].words[0].end_ms == 120.0
    await client.close()


async def test_push_sends_binary_audio() -> None:
    dialer = FakeDialer()
    client = make_client(dialer)
    await client.open("he", ASROptions())
    frame = speech_frame(0.0)
    await client.push(frame)
    assert dialer.sockets[0].sent[-1] == frame.pcm
    await client.close()


async def test_socket_killed_mid_utterance_reconnects_and_continues() -> None:
    dialer = FakeDialer()
    client = make_client(dialer)
    await client.open("he", ASROptions())
    dialer.sockets[0].push_result("תחילת משפט", final=False)
    dialer.sockets[0].die()
    await wait_until(lambda: len(dialer.sockets) == 2)
    # The new socket got the same open handshake and keeps serving results.
    reopened = json.loads(str(dialer.sockets[1].sent[0]))
    assert reopened["type"] == "open"
    assert reopened["language"] == "he"
    dialer.sockets[1].push_result("המשך משפט", final=True)
    results = await collect(client, 2)
    assert results[1].text == "המשך משפט"
    await client.close()


async def test_heartbeat_pings_and_pong_keeps_connection() -> None:
    dialer = FakeDialer(auto_pong=True)
    client = make_client(dialer, heartbeat_interval_s=0.02, heartbeat_timeout_s=0.2)
    await client.open("he", ASROptions())
    await wait_until(
        lambda: any(
            isinstance(m, str) and json.loads(m).get("type") == "ping"
            for m in dialer.sockets[0].sent
        )
    )
    await asyncio.sleep(0.05)
    assert len(dialer.sockets) == 1
    await client.close()


async def test_silently_dead_socket_is_replaced_by_heartbeat() -> None:
    # No pongs and no results: recv blocks forever. Only the pong timeout
    # can notice; it must close the corpse and redial.
    dialer = FakeDialer(auto_pong=False)
    client = make_client(dialer, heartbeat_interval_s=0.02, heartbeat_timeout_s=0.05)
    await client.open("he", ASROptions())
    await wait_until(lambda: len(dialer.sockets) >= 2)
    assert dialer.sockets[0].closed
    dialer.sockets[-1].push_result("אחרי החלפה", final=True)
    results = await collect(client, 1)
    assert results[0].text == "אחרי החלפה"
    await client.close()


async def test_dial_retries_then_gives_up() -> None:
    ok_after_two = FakeDialer(fail_first=2)
    client = make_client(ok_after_two, max_redials=3)
    await client.open("he", ASROptions())
    assert len(ok_after_two.sockets) == 1
    await client.close()

    never_up = FakeDialer(fail_first=10)
    failing = make_client(never_up, max_redials=2)
    with pytest.raises(AsrStreamError, match="after 3 attempts"):
        await failing.open("he", ASROptions())


async def test_server_error_surfaces_through_results() -> None:
    dialer = FakeDialer()
    client = make_client(dialer)
    await client.open("he", ASROptions())
    dialer.sockets[0].push_error("model exploded")
    with pytest.raises(AsrStreamError, match="model exploded"):
        async for _ in client.results():
            pass
