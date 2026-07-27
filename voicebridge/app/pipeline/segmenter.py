"""Utterance segmenter (ADR-004) — the core algorithm of the product.

Pure logic: no I/O, no clocks of its own. Callers pass ``now_ms`` from a
monotonic source, which is what makes every trigger deterministic in tests.

A commit is final (ADR-005). Once tokens are committed they are never
re-emitted, even if the ASR later revises them; revisions of committed words
surface only through the quality tier's transcript correction.
"""

import uuid
from dataclasses import dataclass
from enum import StrEnum

from app.config import SegmenterConfig
from app.pipeline.languages import CLAUSE_PUNCTUATION, LanguageRules
from app.providers.base import ASRResult


class CommitTrigger(StrEnum):
    ASR_FINAL = "asr_final"
    STABILITY = "stability"
    TIMEOUT = "timeout"
    VAD_SILENCE = "vad_silence"


@dataclass(frozen=True, slots=True)
class Commit:
    text: str
    correlation_id: str
    trigger: CommitTrigger
    committed_at_ms: float
    language: str


class Segmenter:
    def __init__(self, config: SegmenterConfig, rules: LanguageRules) -> None:
        self._cfg = config
        self._rules = rules
        self._tokens: list[str] = []
        self._seen_at: list[float] = []
        self._partial_count: list[int] = []
        self._committed = 0

    # --- events ------------------------------------------------------------

    def on_asr_result(self, result: ASRResult, now_ms: float) -> Commit | None:
        tokens = result.text.split()
        if result.is_final:
            return self._commit_final(tokens, now_ms)
        if tokens:
            self._observe(tokens, now_ms)
        return self.poll(now_ms)

    def poll(self, now_ms: float) -> Commit | None:
        return self._try_stability(now_ms) or self._try_timeout(now_ms)

    def on_vad_silence(self, now_ms: float) -> Commit | None:
        if self._committed >= len(self._tokens):
            return None
        return self._slice(len(self._tokens), CommitTrigger.VAD_SILENCE, now_ms)

    # --- trigger 1: ASR endpoint -------------------------------------------

    def _commit_final(self, tokens: list[str], now_ms: float) -> Commit | None:
        # Alignment with committed text is by token count, not content: if the
        # final revised words we already committed, those revisions are lost to
        # the audio channel by design (ADR-005).
        remainder = tokens[self._committed :]
        self._reset_utterance()
        if not remainder:
            return None
        return self._make_commit(" ".join(remainder), CommitTrigger.ASR_FINAL, now_ms)

    # --- trigger 2: stability window ---------------------------------------

    def _observe(self, tokens: list[str], now_ms: float) -> None:
        seen_at: list[float] = []
        partial_count: list[int] = []
        for i, token in enumerate(tokens):
            if i < len(self._tokens) and self._tokens[i] == token:
                seen_at.append(self._seen_at[i])
                partial_count.append(self._partial_count[i] + 1)
            else:
                seen_at.append(now_ms)
                partial_count.append(1)
        self._tokens = tokens
        self._seen_at = seen_at
        self._partial_count = partial_count
        # A hypothesis can shrink below what we already committed; the
        # committed pointer never moves backwards (ADR-005).
        self._committed = min(self._committed, len(tokens))

    def _try_stability(self, now_ms: float) -> Commit | None:
        stable_len = self._committed
        for i in range(self._committed, len(self._tokens)):
            aged = now_ms - self._seen_at[i] >= self._cfg.stability_ms
            confirmed = self._partial_count[i] >= self._cfg.min_stable_partials
            if not (aged and confirmed):
                break
            stable_len = i + 1
        cut = self._last_boundary(stable_len)
        if cut is None:
            return None
        return self._slice(cut, CommitTrigger.STABILITY, now_ms)

    def _last_boundary(self, upto: int) -> int | None:
        for j in range(upto, self._committed, -1):
            if self._tokens[j - 1].endswith(CLAUSE_PUNCTUATION):
                return j
            # A clause-opening conjunction marks a boundary *before* itself:
            # committing "…cancel and" would hand MT a dangling connective.
            if j < len(self._tokens):
                follower = self._tokens[j].casefold()
                if follower in self._rules.clause_conjunctions:
                    return j
        return None

    # --- trigger 3: hard timeout -------------------------------------------

    def _try_timeout(self, now_ms: float) -> Commit | None:
        if self._committed >= len(self._tokens):
            return None
        if now_ms - self._seen_at[self._committed] < self._cfg.max_uncommitted_ms:
            return None
        return self._slice(len(self._tokens), CommitTrigger.TIMEOUT, now_ms)

    # --- shared ------------------------------------------------------------

    def _slice(self, end: int, trigger: CommitTrigger, now_ms: float) -> Commit | None:
        text = " ".join(self._tokens[self._committed : end])
        if not text:
            return None
        self._committed = end
        return self._make_commit(text, trigger, now_ms)

    def _make_commit(self, text: str, trigger: CommitTrigger, now_ms: float) -> Commit:
        return Commit(
            text=text,
            correlation_id=uuid.uuid4().hex,
            trigger=trigger,
            committed_at_ms=now_ms,
            language=self._rules.code,
        )

    def _reset_utterance(self) -> None:
        self._tokens = []
        self._seen_at = []
        self._partial_count = []
        self._committed = 0
