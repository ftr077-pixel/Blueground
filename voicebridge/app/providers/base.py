"""Vendor-facing contracts (SPEC.md §6.2-§6.4).

Vendor SDK types must never leak past implementations of these protocols.

Amendment note (§6.4): the spec's ``synthesize`` returns a bare frame
iterator, which leaves ``cancel`` with no way to obtain its handle.
``synthesize`` here returns a ``Synthesis`` carrying both the handle and the
frame stream. Proposed as an amendment to SPEC.md §6.4; flagged in the M1
report.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.audio.frames import AudioFrame
from app.types import Direction

Tier = Literal["fast", "quality"]


# --- ASR (§6.2) -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Word:
    text: str
    start_ms: float
    end_ms: float
    confidence: float | None


@dataclass(frozen=True, slots=True)
class ASRResult:
    text: str
    is_final: bool
    confidence: float | None
    words: tuple[Word, ...]
    received_at: float
    """Monotonic ms, stamped by us at receipt — never trusted from the vendor."""


@dataclass(frozen=True, slots=True)
class ASROptions:
    sample_rate: int = 16_000
    keyterms: tuple[str, ...] = ()


class ASRProvider(Protocol):
    async def open(self, language: str, opts: ASROptions) -> None: ...
    async def push(self, frame: AudioFrame) -> None: ...
    def results(self) -> AsyncIterator[ASRResult]: ...
    async def close(self) -> None: ...


# --- MT (§6.3) --------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Turn:
    direction: Direction
    source_lang: str
    target_lang: str
    source_text: str
    translated_text: str


@dataclass(frozen=True, slots=True)
class GlossaryEntry:
    source: str
    target: str | None
    """None means the term must never be translated (ADR-007)."""


@dataclass(frozen=True, slots=True)
class Glossary:
    entries: tuple[GlossaryEntry, ...] = ()


@dataclass(frozen=True, slots=True)
class Translation:
    text: str
    tier: Tier
    confidence: float | None = None


class Translator(Protocol):
    async def translate(
        self,
        text: str,
        source: str,
        target: str,
        context: list[Turn],
        glossary: Glossary | None,
        tier: Tier,
    ) -> Translation: ...


# --- TTS (§6.4, amended — see module docstring) -----------------------------


@dataclass(frozen=True, slots=True)
class VoiceSpec:
    voice_id: str
    language: str
    sample_rate: int = 16_000


@dataclass(frozen=True, slots=True)
class SynthesisHandle:
    id: str


@dataclass(slots=True)
class Synthesis:
    handle: SynthesisHandle
    frames: AsyncIterator[AudioFrame] = field(repr=False)
    """Must yield the first chunk before synthesis completes (streaming TTS)."""


class TTSProvider(Protocol):
    def synthesize(self, text: str, voice: VoiceSpec) -> Synthesis: ...

    async def cancel(self, handle: SynthesisHandle) -> None:
        """Abort in-flight synthesis. Must complete in <50 ms."""
        ...
