"""Каскад: ASR → LLM-перевод → TTS. Работает в обе стороны."""
from __future__ import annotations

import asyncio
import logging
import time

import numpy as np

from ..services.asr_whisper import WhisperASR
from ..services.mt_qwen import QwenTranslator
from .base import TranslationPipeline, TranslationResult

log = logging.getLogger(__name__)


class CascadePipeline(TranslationPipeline):
    def __init__(self, src: str, dst: str, asr: WhisperASR,
                 translator: QwenTranslator, tts):
        self.src, self.dst = src, dst
        self.asr = asr
        self.translator = translator  # общий на оба направления → общая история
        self.tts = tts
        self._lock = asyncio.Lock()

    async def process(self, utterance: np.ndarray) -> TranslationResult:
        async with self._lock:
            t0 = time.monotonic()
            text = await self.asr.transcribe(utterance)
            t1 = time.monotonic()
            if not text:
                return TranslationResult("", "", np.zeros(0, np.float32), 16000)
            translated = await self.translator.translate(text, self.src, self.dst)
            t2 = time.monotonic()
            audio, rate = await self.tts.synth(translated)
            t3 = time.monotonic()
            log.info(
                "[%s→%s] asr=%.2fs mt=%.2fs tts=%.2fs | %r → %r",
                self.src, self.dst, t1 - t0, t2 - t1, t3 - t2, text, translated,
            )
            return TranslationResult(text, translated, audio, rate)
