"""Voice-activity detection boundary.

ADR-008 sanctions Silero as the one local model, describing it as "a few
megabytes on CPU". Measured, the ``silero-vad`` package pulls torch plus the
NVIDIA runtime — 4.6 GB in a clean environment. That is not what the ADR
budgeted for, so M0 runs ``EnergyVad`` below and the Silero decision is
deferred with real numbers attached (see the milestone report).

The pipeline depends on the protocol, not the detector, so swapping in Silero
later touches one line in the factory.
"""

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from app.audio.frames import AudioFrame, require_internal


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


class EnergyVad:
    """Adaptive energy gate — the M0 stand-in for Silero.

    Tracks a noise floor from the quiet frames and calls speech when a frame
    rises a fixed ratio above it, so it survives the constant hiss of a
    mobile call without needing a tuned absolute threshold. A hangover keeps
    short gaps inside a word from reading as silence.

    It will misfire on hold music and loud background speech, which is why
    ADR-004's other three triggers carry the segmentation decision and this
    one is only a guarantee.
    """

    def __init__(
        self,
        *,
        snr_ratio: float = 3.0,
        min_level: float = 180.0,
        hangover_ms: float = 200.0,
        adapt: float = 0.05,
    ) -> None:
        self._snr_ratio = snr_ratio
        self._min_level = min_level
        self._hangover_ms = hangover_ms
        self._adapt = adapt
        self._noise = min_level
        self._speaking = False
        self._hangover_left_ms = 0.0
        self._silence_ms = 0.0

    def process(self, frame: AudioFrame) -> VadFrameResult:
        require_internal(frame)
        level = _rms(frame.pcm)
        threshold = max(self._noise * self._snr_ratio, self._min_level)
        loud = level >= threshold

        if loud:
            self._hangover_left_ms = self._hangover_ms
        else:
            self._hangover_left_ms = max(0.0, self._hangover_left_ms - frame.duration_ms)
            # Adapt only on quiet frames, or a long utterance would drag the
            # floor up and mute the speaker.
            self._noise = (1 - self._adapt) * self._noise + self._adapt * level

        is_speech = loud or self._hangover_left_ms > 0.0
        onset = is_speech and not self._speaking
        self._speaking = is_speech
        if is_speech:
            self._silence_ms = 0.0
        else:
            self._silence_ms += frame.duration_ms
        return VadFrameResult(is_speech=is_speech, onset=onset, silence_ms=self._silence_ms)

    def reset(self) -> None:
        self._noise = self._min_level
        self._speaking = False
        self._hangover_left_ms = 0.0
        self._silence_ms = 0.0


def _rms(pcm: bytes) -> float:
    # numpy, not a Python loop: this runs twice per 20 ms frame for the life
    # of every call, and the hot path has a 10 ms budget per operation.
    samples = np.frombuffer(pcm, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))


class SileroVad:
    """Thin adapter over silero-vad (optional dependency group ``vad``).

    UNVERIFIED offline: exercising it requires the silero-vad wheel and real
    audio. All offline tests use a fake behind ``VoiceActivityDetector``.
    """

    _WINDOW_SAMPLES = 512  # Silero's required chunk size at 16 kHz

    def __init__(self, threshold: float = 0.5) -> None:
        import torch
        from silero_vad import load_silero_vad

        self._torch = torch
        self._model = load_silero_vad()
        self._threshold = threshold
        self._buffer = b""
        self._speaking = False
        self._silence_ms = 0.0

    def process(self, frame: AudioFrame) -> VadFrameResult:
        from app.audio.frames import require_internal

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
