"""Интерфейс пайплайна перевода: реплика-аудио на входе, перевод на выходе.

Единственный контракт в системе. Cascade и Seamless реализуют его же,
поэтому направления переключаются в config.yaml без изменения кода.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


@dataclass
class TranslationResult:
    source_text: str          # что распознали (пусто у чистого S2S)
    translated_text: str      # что перевели (для транскрипта в UI)
    audio: np.ndarray         # float32 mono
    sample_rate: int


class TranslationPipeline(ABC):
    """Реализации обязаны быть безопасны для конкурентных вызовов
    (внутри — asyncio.Lock, если модель не reentrant)."""

    src: str  # "he" | "en"
    dst: str

    @abstractmethod
    async def process(self, utterance: np.ndarray) -> TranslationResult:
        """utterance: float32 mono @16k, одна законченная реплика."""
