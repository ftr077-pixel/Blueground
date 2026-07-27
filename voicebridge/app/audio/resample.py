"""Streaming 2x resampler for the PSTN boundary (8 kHz <-> 16 kHz).

Amendment note (ADR-002 says "use soxr"): soxr's ResampleStream is unusable
in the 20 ms hot path — measured on 20 ms chunks, it emits NOTHING for the
first ~100 ms of input and holds 26-66 ms of audio at steady state depending
on filter quality (MQ 26 ms, HQ 66 ms; QQ is low-latency but only 17.7 dB
SNR, too lossy to feed ASR). A phone conversation cannot absorb a hidden
100 ms start plus ~26 ms per direction.

The only in-pipeline conversion is exactly 2:1 (ADR-002 normalises everything
else at the vendors: TTS is requested at 16 kHz directly). A fixed-ratio
half-band windowed-sinc FIR does this with (taps-1)/2 = 31 samples of group
delay at 16 kHz — 1.9 ms — and >50 dB SNR on telephony-band signal, verified
in tests. Proposed as an ADR-002 amendment; flagged in the milestone report.
"""

import numpy as np
import numpy.typing as npt

TAPS = 63


def _halfband_kernel() -> npt.NDArray[np.float64]:
    n = np.arange(TAPS) - (TAPS - 1) / 2
    kernel = np.sinc(n / 2.0) * np.kaiser(TAPS, 9.0)
    return np.asarray(kernel / kernel.sum(), dtype=np.float64)


class _StreamingFir:
    """Overlap-save FIR at the high rate; carries taps-1 samples of history."""

    def __init__(self) -> None:
        self._kernel = _halfband_kernel()
        self._tail = np.zeros(TAPS - 1, dtype=np.float64)

    def process(self, x: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
        buffer = np.concatenate([self._tail, x])
        out = np.convolve(buffer, self._kernel, mode="valid")
        self._tail = buffer[len(buffer) - (TAPS - 1) :]
        return np.asarray(out, dtype=np.float64)


def _to_int16_bytes(y: npt.NDArray[np.float64]) -> bytes:
    return bytes(np.clip(np.rint(y), -32768, 32767).astype(np.int16).tobytes())


class StreamResampler:
    """Stateful streaming resampler; supports exactly 8000<->16000.

    Stateful because a fresh filter per 20 ms frame would lose history at
    every frame edge and produce audible seams.
    """

    def __init__(self, in_rate: int, out_rate: int) -> None:
        if {in_rate, out_rate} != {8000, 16000}:
            raise ValueError(
                f"only the 8 kHz <-> 16 kHz PSTN conversion is supported, "
                f"got {in_rate} -> {out_rate}"
            )
        self.in_rate = in_rate
        self.out_rate = out_rate
        self._fir = _StreamingFir()
        self._decimate_phase = 0

    def process(self, pcm: bytes, last: bool = False) -> bytes:
        x = np.frombuffer(pcm, dtype=np.int16).astype(np.float64)
        chunks = [self._run(x)]
        if last:
            # Push the held group delay out with high-rate silence.
            tail = self._fir.process(np.zeros(TAPS - 1, dtype=np.float64))
            if self.in_rate > self.out_rate:
                picked = tail[self._decimate_phase :: 2]
                self._decimate_phase = (self._decimate_phase - tail.size) % 2
                chunks.append(_to_int16_bytes(picked))
            else:
                chunks.append(_to_int16_bytes(tail))
        return b"".join(chunks)

    def _run(self, x: npt.NDArray[np.float64]) -> bytes:
        if x.size == 0:
            return b""
        if self.in_rate < self.out_rate:
            # Upsample: zero-stuff to 16 kHz, filter images, x2 gain to
            # compensate the stuffing.
            high = np.zeros(x.size * 2, dtype=np.float64)
            high[::2] = x * 2.0
            return _to_int16_bytes(self._fir.process(high))
        # Downsample: filter at 16 kHz first (anti-alias), then decimate,
        # keeping phase parity across arbitrary chunk sizes.
        y = self._fir.process(x)
        picked = y[self._decimate_phase :: 2]
        self._decimate_phase = (self._decimate_phase - y.size) % 2
        return _to_int16_bytes(picked)
