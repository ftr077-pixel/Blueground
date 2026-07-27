"""Voice-activity detection boundary.

The only sanctioned local model is Silero (ADR-008). The pipeline depends on
the protocol, not the model, so the segmenter and duplex controller are fully
testable with a fake.
"""

from dataclasses import dataclass
from typing import Protocol

from app.audio.frames import AudioFrame


@dataclass(frozen=True, slots=True)
class VadFrameResult:
    is_speech: bool
    onset: bool
    """True on the first speech frame after silence."""
    silence_ms: float
    """Continuous silence duration up to and including this frame; 0 during speech."""


class VoiceActivityDetector(Protocol):
    def process(self, frame: AudioFrame) -> VadFrameResult: ...
    def reset(self) -> None: ...


class SileroVad:
    """Thin adapter over silero-vad (optional dependency group ``vad``).

    UNVERIFIED offline: exercising it requires the silero-vad wheel and real
    audio. All offline tests use a fake behind ``VoiceActivityDetector``.
    """

    _WINDOW_SAMPLES = 512  # Silero's required chunk size at 16 kHz

    def __init__(self, threshold: float = 0.5) -> None:
        import torch  # noqa: PLC0415 — heavy optional import, deferred on purpose
        from silero_vad import load_silero_vad  # noqa: PLC0415

        self._torch = torch
        self._model = load_silero_vad()
        self._threshold = threshold
        self._buffer = b""
        self._speaking = False
        self._silence_ms = 0.0

    def process(self, frame: AudioFrame) -> VadFrameResult:
        from app.audio.frames import require_internal  # noqa: PLC0415

        require_internal(frame)
        self._buffer += frame.pcm
        window_bytes = self._WINDOW_SAMPLES * 2
        speech_seen = False
        while len(self._buffer) >= window_bytes:
            chunk, self._buffer = self._buffer[:window_bytes], self._buffer[window_bytes:]
            tensor = self._torch.frombuffer(chunk, dtype=self._torch.int16).float() / 32768.0
            prob = float(self._model(tensor, frame.sample_rate).item())
            speech_seen = speech_seen or prob >= self._threshold
        onset = speech_seen and not self._speaking
        if speech_seen:
            self._speaking = True
            self._silence_ms = 0.0
        else:
            self._speaking = False
            self._silence_ms += frame.duration_ms
        return VadFrameResult(is_speech=speech_seen, onset=onset, silence_ms=self._silence_ms)

    def reset(self) -> None:
        self._buffer = b""
        self._speaking = False
        self._silence_ms = 0.0
