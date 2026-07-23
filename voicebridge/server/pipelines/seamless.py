"""Seamless S2S для he→en (иврита на выход у Seamless нет — en→he тут не бывает).

Сейчас: turn-based SeamlessM4T v2 (речь-реплика → речь-перевод), тот же
контракт TranslationPipeline, что и у каскада — переключается в config.yaml.

TODO (v2, симультанность): SeamlessStreaming-агент из пакета
`seamless_communication` переводит ПОКА клиент говорит (~2s trailing delay).
Для него нужен другой поток данных (чанки, не реплики) — интеграция:
завести в CallSession режим streaming, где чанки минуют UtteranceDetector
и льются прямо в агента, а его инкрементальный аудио-выход — оператору.
Класс ниже остаётся fallback'ом для A/B.
"""
from __future__ import annotations

import asyncio

import numpy as np
import torch
from transformers import AutoProcessor, SeamlessM4Tv2Model

from .base import TranslationPipeline, TranslationResult


class SeamlessPipeline(TranslationPipeline):
    RATE_OUT = 16000

    def __init__(self, src: str = "he", dst: str = "en",
                 model: str = "facebook/seamless-m4t-v2-large", device: str = "cuda"):
        assert (src, dst) == ("he", "en"), "Seamless: только he→en (нет he на выход)"
        self.src, self.dst = src, dst
        self.device = device
        self.processor = AutoProcessor.from_pretrained(model)
        self.model = SeamlessM4Tv2Model.from_pretrained(
            model, torch_dtype=torch.float16
        ).to(device).eval()
        self._lock = asyncio.Lock()

    def _infer_sync(self, utterance: np.ndarray) -> tuple[str, np.ndarray]:
        inputs = self.processor(
            audios=utterance, sampling_rate=16000, return_tensors="pt"
        ).to(self.device)
        with torch.no_grad():
            # речь + текст за один проход
            out = self.model.generate(**inputs, tgt_lang="eng", generate_speech=True)
        audio = out[0].squeeze().float().cpu().numpy()
        # текст перевода для транскрипта в UI
        with torch.no_grad():
            text_ids = self.model.generate(**inputs, tgt_lang="eng", generate_speech=False)
        text = self.processor.decode(text_ids[0].tolist()[0], skip_special_tokens=True)
        return text, audio

    async def process(self, utterance: np.ndarray) -> TranslationResult:
        async with self._lock:
            text, audio = await asyncio.to_thread(self._infer_sync, utterance)
            return TranslationResult("", text, audio, self.RATE_OUT)
