"""TTS: иврит — MMS-TTS-heb (16k), английский — Kokoro-82M (24k, CPU ok).

Оба возвращают (float32 mono, sample_rate).
Иврит-TTS — самое слабое место локального стека; интерфейс намеренно
одинаковый, чтобы при необходимости подменить на API одним классом.
"""
from __future__ import annotations

import asyncio

import numpy as np
import torch
from transformers import AutoTokenizer, VitsModel


class HebrewTTS:
    RATE = 16000

    def __init__(self, model: str = "facebook/mms-tts-heb", device: str = "cuda"):
        self.model = VitsModel.from_pretrained(model).to(device).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(model)
        self.device = device

    def _synth_sync(self, text: str) -> np.ndarray:
        inputs = self.tokenizer(text, return_tensors="pt").to(self.device)
        with torch.no_grad():
            wav = self.model(**inputs).waveform
        return wav.squeeze(0).float().cpu().numpy()

    async def synth(self, text: str) -> tuple[np.ndarray, int]:
        if not text:
            return np.zeros(0, dtype=np.float32), self.RATE
        return await asyncio.to_thread(self._synth_sync, text), self.RATE


class EnglishTTS:
    RATE = 24000

    def __init__(self, voice: str = "af_heart"):
        from kokoro import KPipeline
        self.pipe = KPipeline(lang_code="a")  # американский английский
        self.voice = voice

    def _synth_sync(self, text: str) -> np.ndarray:
        chunks = [audio for _gs, _ps, audio in self.pipe(text, voice=self.voice)]
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])

    async def synth(self, text: str) -> tuple[np.ndarray, int]:
        if not text:
            return np.zeros(0, dtype=np.float32), self.RATE
        return await asyncio.to_thread(self._synth_sync, text), self.RATE
