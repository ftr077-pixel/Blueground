"""ASR через faster-whisper (CTranslate2).

Иврит: ivrit-ai/whisper-large-v3-turbo-ct2 — файнтюн на израильском иврите,
на телефонном 8k→16k звуке заметно лучше ванильного whisper.
Английский: small.en — реплики сотрудника короткие, хватает с запасом.
"""
from __future__ import annotations

import asyncio

import numpy as np
from faster_whisper import WhisperModel


class WhisperASR:
    def __init__(self, model: str, language: str, compute_type: str = "int8", device: str = "cuda"):
        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.language = language

    def _transcribe_sync(self, audio: np.ndarray) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=1,               # latency > качество на десятые доли WER
            vad_filter=False,          # VAD уже сделан снаружи
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()

    async def transcribe(self, audio: np.ndarray) -> str:
        """audio: float32 mono @16k. Блокирующий инференс уводим в поток."""
        return await asyncio.to_thread(self._transcribe_sync, audio)
