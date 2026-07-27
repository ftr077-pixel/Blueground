"""Shared direction/side vocabulary used across pipeline, telephony and events."""

from typing import Literal

Side = Literal["caller", "operator"]
Direction = Literal["a2b", "b2a"]

# a2b: caller (language A) speaks, operator (language B) hears the translation.


def source_side(direction: Direction) -> Side:
    return "caller" if direction == "a2b" else "operator"


def target_side(direction: Direction) -> Side:
    return "operator" if direction == "a2b" else "caller"
