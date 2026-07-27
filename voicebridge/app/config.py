"""Runtime configuration. All thresholds come from the environment (ADR-004)."""

import os
from collections.abc import Mapping
from dataclasses import dataclass


def _float_env(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    return default if raw is None else float(raw)


def _int_env(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    return default if raw is None else int(raw)


@dataclass(frozen=True, slots=True)
class SegmenterConfig:
    """ADR-004 thresholds. Defaults are the spec's starting values, not tuned truth."""

    stability_ms: float = 320.0
    min_stable_partials: int = 2
    max_uncommitted_ms: float = 2500.0
    vad_silence_ms: float = 500.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "SegmenterConfig":
        e = os.environ if env is None else env
        return cls(
            stability_ms=_float_env(e, "STABILITY_MS", 320.0),
            min_stable_partials=_int_env(e, "MIN_STABLE_PARTIALS", 2),
            max_uncommitted_ms=_float_env(e, "MAX_UNCOMMITTED_MS", 2500.0),
            vad_silence_ms=_float_env(e, "VAD_SILENCE_MS", 500.0),
        )


@dataclass(frozen=True, slots=True)
class DuplexConfig:
    """ADR-006 queue policy."""

    max_queue_ms: float = 3000.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "DuplexConfig":
        e = os.environ if env is None else env
        return cls(max_queue_ms=_float_env(e, "MAX_QUEUE_MS", 3000.0))
