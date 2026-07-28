"""EnergyVad tests — the M0 stand-in must survive a noisy telephone line
without either muting the speaker or triggering on hiss."""

import math

from app.audio.frames import AudioFrame
from app.audio.vad import EnergyVad

FRAME_SAMPLES = 320  # 20 ms at 16 kHz


def frame(amplitude: float, ts_ms: float = 0.0, freq: float = 300.0) -> AudioFrame:
    pcm = bytearray()
    for n in range(FRAME_SAMPLES):
        value = int(amplitude * math.sin(2 * math.pi * freq * n / 16000))
        pcm += max(-32768, min(32767, value)).to_bytes(2, "little", signed=True)
    return AudioFrame(pcm=bytes(pcm), sample_rate=16000, ts_ms=ts_ms)


def feed(vad: EnergyVad, amplitude: float, count: int, start_ms: float = 0.0) -> list[bool]:
    return [vad.process(frame(amplitude, start_ms + i * 20.0)).is_speech for i in range(count)]


class TestSpeechDetection:
    def test_silence_is_never_speech(self) -> None:
        vad = EnergyVad()
        assert not any(feed(vad, 0.0, 50))

    def test_loud_speech_is_detected(self) -> None:
        vad = EnergyVad()
        feed(vad, 30.0, 25)  # settle the noise floor on a quiet line
        assert vad.process(frame(6000.0)).is_speech

    def test_onset_fires_once_per_utterance(self) -> None:
        vad = EnergyVad()
        feed(vad, 20.0, 25)
        onsets = [vad.process(frame(6000.0, i * 20.0)).onset for i in range(10)]
        assert onsets[0] is True
        assert not any(onsets[1:])

    def test_quiet_line_hiss_does_not_trigger(self) -> None:
        vad = EnergyVad()
        assert not any(feed(vad, 60.0, 100))

    def test_speaker_is_not_muted_by_a_long_utterance(self) -> None:
        # The noise floor must not creep up during sustained speech.
        vad = EnergyVad()
        feed(vad, 20.0, 25)
        sustained = feed(vad, 5000.0, 250, start_ms=500.0)  # 5 seconds
        assert all(sustained), "detector went deaf mid-utterance"


class TestSilenceAccounting:
    def test_silence_accumulates_after_speech(self) -> None:
        vad = EnergyVad(hangover_ms=200.0)
        feed(vad, 20.0, 25)
        feed(vad, 6000.0, 10)
        results = [vad.process(frame(0.0, 1000.0 + i * 20.0)) for i in range(40)]
        silences = [r.silence_ms for r in results if not r.is_speech]
        assert silences[0] == 20.0
        assert silences[-1] > 500.0  # long enough to fire ADR-004's VAD trigger

    def test_hangover_bridges_a_gap_inside_a_word(self) -> None:
        vad = EnergyVad(hangover_ms=200.0)
        feed(vad, 20.0, 25)
        feed(vad, 6000.0, 5)
        # A 100 ms dip must not read as the end of the utterance.
        assert all(feed(vad, 0.0, 5, start_ms=600.0))

    def test_reset_clears_state(self) -> None:
        vad = EnergyVad()
        feed(vad, 6000.0, 10)
        vad.reset()
        assert not vad.process(frame(0.0)).is_speech
