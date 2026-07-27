"""Streaming resampler over soxr (ADR-002 — never naive interpolation)."""

import numpy as np
import soxr


class StreamResampler:
    """Stateful resampler for one continuous stream.

    Stateful because a fresh resampler per 20 ms frame would lose filter
    history at every frame edge and produce audible artifacts.
    """

    def __init__(self, in_rate: int, out_rate: int) -> None:
        self.in_rate = in_rate
        self.out_rate = out_rate
        self._stream = soxr.ResampleStream(in_rate, out_rate, 1, dtype="int16")

    def process(self, pcm: bytes, last: bool = False) -> bytes:
        samples = np.frombuffer(pcm, dtype=np.int16)
        out = self._stream.resample_chunk(samples, last=last)
        return bytes(out.astype(np.int16).tobytes())
