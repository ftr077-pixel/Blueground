"""MessageStream adapters for real sockets.

Two directions of the same protocol: inbound sockets handed to us by the web
framework, and outbound sockets we dial to vendors. Both are reduced to the
three calls in ``app.transport`` so every component above stays testable
without a network.
"""

import asyncio
import contextlib
from collections.abc import Mapping

import websockets
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.transport import MessageStream

MAX_MESSAGE_BYTES = 1 << 20


class ServerSocket:
    """A connection the framework accepted for us (Twilio or the console).

    Sends are serialised. Both sockets are written to by more than one task
    at a time — audio frames from the duplex worker, ``clear`` from the
    barge-in path, transcript JSON from the console feed — and interleaving
    two writes corrupts the frame stream, which kills the connection a
    second or two into the call.
    """

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws
        self._send_lock = asyncio.Lock()

    async def recv(self) -> str | bytes | None:
        try:
            message = await self._ws.receive()
        except (WebSocketDisconnect, RuntimeError):
            return None
        kind = message.get("type")
        if kind == "websocket.disconnect":
            return None
        text = message.get("text")
        if text is not None:
            return str(text)
        data = message.get("bytes")
        if data is not None:
            return bytes(data)
        return b""

    async def send(self, data: str | bytes) -> None:
        async with self._send_lock:
            if self._ws.client_state is not WebSocketState.CONNECTED:
                raise ConnectionError("websocket is not connected")
            try:
                if isinstance(data, str):
                    await self._ws.send_text(data)
                else:
                    await self._ws.send_bytes(data)
            except (WebSocketDisconnect, RuntimeError) as exc:
                raise ConnectionError("websocket send failed") from exc

    async def close(self) -> None:
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            await self._ws.close()


class ClientSocket:
    """A connection we dialled out to a vendor."""

    def __init__(self, ws: websockets.ClientConnection) -> None:
        self._ws = ws
        self._send_lock = asyncio.Lock()

    async def recv(self) -> str | bytes | None:
        try:
            return await self._ws.recv()
        except websockets.ConnectionClosed:
            return None

    async def send(self, data: str | bytes) -> None:
        async with self._send_lock:
            try:
                await self._ws.send(data)
            except websockets.ConnectionClosed as exc:
                raise ConnectionError("vendor websocket closed") from exc

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._ws.close()


async def dial(url: str, headers: Mapping[str, str] | None = None) -> MessageStream:
    """Open a vendor WebSocket. Raises ConnectionError so provider clients'
    redial logic can catch a single exception type."""
    try:
        connection = await websockets.connect(
            url,
            additional_headers=dict(headers or {}),
            max_size=MAX_MESSAGE_BYTES,
            open_timeout=10,
            ping_interval=None,
        )
    except (OSError, websockets.WebSocketException, TimeoutError) as exc:
        raise ConnectionError(f"dial failed: {type(exc).__name__}") from exc
    return ClientSocket(connection)
