"""Audio boundary tests: codec fidelity, resampler continuity, and the
ADR-002 assertions that make sample-rate confusion fail loudly."""

import math

import pytest

from app.audio.codecs import mulaw_decode, mulaw_encode
from app.audio.frames import AudioFormatError, AudioFrame, require_internal
from app.audio.resample import StreamResampler

from tests.support.fakes import EnergyVad, silence_frame, speech_frame


def sine_pcm(samples: int, rate: int, freq: float, amplitude: int) -> bytes:
    values = bytearray()
    for n in range(samples):
        v = int(amplitude * math.sin(2 * math.pi * freq * n / rate))
        values += v.to_bytes(2, "little", signed=True)
    return bytes(values)


class TestMulaw:
    def test_roundtrip_error_is_bounded(self) -> None:
        original = sine_pcm(160, 8000, 440.0, amplitude=8000)
        decoded = mulaw_decode(mulaw_encode(original))
        assert len(decoded) == len(original)
        worst = 0
        for i in range(0, len(original), 2):
            a = int.from_bytes(original[i : i + 2], "little", signed=True)
            b = int.from_bytes(decoded[i : i + 2], "little", signed=True)
            worst = max(worst, abs(a - b))
        assert worst < 512

    def test_encode_halves_byte_count(self) -> None:
        pcm = sine_pcm(160, 8000, 300.0, amplitude=5000)
        assert len(mulaw_encode(pcm)) == len(pcm) // 2


class TestStreamResampler:
    def test_8k_to_16k_doubles_sample_count(self) -> None:
        resampler = StreamResampler(8000, 16000)
        total_out = 0
        for _ in range(5):
            chunk = sine_pcm(160, 8000, 440.0, amplitude=8000)
            total_out += len(resampler.process(chunk)) // 2
        total_out += len(resampler.process(b"", last=True)) // 2
        assert 5 * 160 * 2 * 0.95 <= total_out <= 5 * 160 * 2 * 1.05

    def test_chunked_stream_matches_one_shot_resample(self) -> None:
        # Statefulness is the point: 20 ms chunks through the stream must
        # produce the same signal as resampling the whole buffer at once.
        # A per-chunk stateless resample would show seam artifacts here.
        import numpy as np
        import soxr

        signal = sine_pcm(1600, 8000, 440.0, amplitude=9000)
        stream = StreamResampler(8000, 16000)
        chunked = b"".join(
            stream.process(signal[i : i + 320]) for i in range(0, len(signal), 320)
        ) + stream.process(b"", last=True)
        one_shot = soxr.resample(
            np.frombuffer(signal, dtype=np.int16), 8000, 16000
        ).astype(np.int16)
        chunked_arr = np.frombuffer(chunked, dtype=np.int16)
        assert abs(len(chunked_arr) - len(one_shot)) <= 16
        n = min(len(chunked_arr), len(one_shot))
        assert int(np.abs(chunked_arr[:n].astype(np.int32) - one_shot[:n]).max()) < 100


class TestFrameAssertions:
    def test_require_internal_rejects_narrowband(self) -> None:
        frame = AudioFrame(pcm=b"\x00\x00" * 160, sample_rate=8000, ts_ms=0.0)
        with pytest.raises(AudioFormatError):
            require_internal(frame)

    def test_odd_pcm_length_rejected(self) -> None:
        with pytest.raises(AudioFormatError):
            AudioFrame(pcm=b"\x00" * 3, sample_rate=16000, ts_ms=0.0)

    def test_duration(self) -> None:
        assert speech_frame(0.0).duration_ms == 20.0


class TestEnergyVad:
    def test_onset_silence_cycle(self) -> None:
        vad = EnergyVad()
        first = vad.process(speech_frame(0.0))
        assert first.is_speech and first.onset
        second = vad.process(speech_frame(20.0))
        assert second.is_speech and not second.onset
        s1 = vad.process(silence_frame(40.0))
        assert not s1.is_speech and s1.silence_ms == 20.0
        s2 = vad.process(silence_frame(60.0))
        assert s2.silence_ms == 40.0
        again = vad.process(speech_frame(80.0))
        assert again.onset
