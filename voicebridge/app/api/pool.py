"""Operator waiting room.

M0 pairs one caller with one waiting operator: the operator opens the console
and waits, the next inbound call claims them. Nothing here is a routing
engine — call routing is an explicit non-goal (SPEC §1.3).
"""

import asyncio
from collections import deque
from dataclasses import dataclass, field

from app.transport import MessageStream


@dataclass(slots=True)
class WaitingOperator:
    ws: MessageStream
    claimed: asyncio.Event = field(default_factory=asyncio.Event)
    released: asyncio.Event = field(default_factory=asyncio.Event)
    gone: bool = False


class OperatorPool:
    def __init__(self) -> None:
        self._waiting: deque[WaitingOperator] = deque()

    def register(self, ws: MessageStream) -> WaitingOperator:
        operator = WaitingOperator(ws=ws)
        self._waiting.append(operator)
        return operator

    def claim(self) -> WaitingOperator | None:
        """Take the longest-waiting operator who is still connected."""
        while self._waiting:
            operator = self._waiting.popleft()
            if operator.gone:
                continue
            operator.claimed.set()
            return operator
        return None

    def drop(self, operator: WaitingOperator) -> None:
        operator.gone = True
        operator.released.set()
        try:
            self._waiting.remove(operator)
        except ValueError:
            pass

    @property
    def available(self) -> int:
        return sum(1 for operator in self._waiting if not operator.gone)
