"""Silero VAD + сегментация реплик.

UtteranceDetector принимает поток чанков float32 @16k и выдаёт целые
реплики (numpy array), когда после речи наступила пауза >= min_silence_ms.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch

_RATE = 16000
_WINDOW = 512  # сэмплов на один прогон silero (32 ms @ 16k)


class SileroVAD:
    def __init__(self, threshold: float = 0.5):
        self.model, _ = torch.hub.load(
            "snakers4/silero-vad", "silero_vad", trust_repo=True
        )
        self.threshold = threshold
        self._buf = np.zeros(0, dtype=np.float32)

    def push(self, chunk: np.ndarray) -> list[bool]:
        """Возвращает решение речь/тишина на каждые 32ms поступившего аудио."""
        self._buf = np.concatenate([self._buf, chunk])
        out = []
        while len(self._buf) >= _WINDOW:
            frame, self._buf = self._buf[:_WINDOW], self._buf[_WINDOW:]
            p = self.model(torch.from_numpy(frame), _RATE).item()
            out.append(p >= self.threshold)
        return out


@dataclass
class UtteranceDetector:
    vad: SileroVAD
    min_silence_ms: int = 500
    min_speech_ms: int = 250
    max_utterance_s: int = 30

    _audio: list[np.ndarray] = field(default_factory=list)
    _speech_frames: int = 0
    _silence_frames: int = 0
    _in_speech: bool = False

    @property
    def speaking(self) -> bool:
        return self._in_speech

    def push(self, chunk: np.ndarray) -> np.ndarray | None:
        """Скармливаем чанк; возвращает готовую реплику или None."""
        self._audio.append(chunk)
        for is_speech in self.vad.push(chunk):
            if is_speech:
                self._speech_frames += 1
                self._silence_frames = 0
                if not self._in_speech and self._speech_frames * 32 >= self.min_speech_ms:
                    self._in_speech = True
            else:
                self._silence_frames += 1

            total_s = sum(len(a) for a in self._audio) / _RATE
            end_of_turn = self._in_speech and (
                self._silence_frames * 32 >= self.min_silence_ms
                or total_s >= self.max_utterance_s
            )
            if end_of_turn:
                utterance = np.concatenate(self._audio)
                self._reset()
                return utterance

        # мусорную тишину без речи периодически сбрасываем
        if not self._in_speech and sum(len(a) for a in self._audio) > _RATE * 5:
            self._audio = self._audio[-4:]
        return None

    def _reset(self):
        self._audio = []
        self._speech_frames = 0
        self._silence_frames = 0
        self._in_speech = False
