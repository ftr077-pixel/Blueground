"""Minimal duplex message transport shared by the telephony adapter and the
streaming provider clients.

A websocket stripped to the three calls we use, so every wire client in the
codebase is testable offline by injecting queues instead of sockets. The API
layer adapts real websocket connections to this protocol in one place.
"""

from typing import Protocol


class MessageStream(Protocol):
    """``recv`` returns ``None`` when the peer closes."""

    async def recv(self) -> str | bytes | None: ...
    async def send(self, data: str | bytes) -> None: ...
    async def close(self) -> None: ...
