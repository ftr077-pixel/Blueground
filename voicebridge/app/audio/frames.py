"""Canonical internal audio representation (ADR-002): 16 kHz mono PCM16LE."""

from dataclasses import dataclass

INTERNAL_SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
FRAME_MS = 20


class AudioFormatError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class AudioFrame:
    """One chunk of mono signed 16-bit little-endian PCM.

    ``ts_ms`` is a monotonic capture timestamp in milliseconds, stamped by us
    at ingress — never trusted from a vendor.
    """

    pcm: bytes
    sample_rate: int
    ts_ms: float

    def __post_init__(self) -> None:
        if len(self.pcm) % BYTES_PER_SAMPLE != 0:
            raise AudioFormatError(f"odd PCM16 byte length {len(self.pcm)}")

    @property
    def samples(self) -> int:
        return len(self.pcm) // BYTES_PER_SAMPLE

    @property
    def duration_ms(self) -> float:
        return self.samples * 1000.0 / self.sample_rate


def require_internal(frame: AudioFrame) -> AudioFrame:
    """Boundary assertion per ADR-002 — sample-rate confusion must fail loudly."""
    if frame.sample_rate != INTERNAL_SAMPLE_RATE:
        raise AudioFormatError(
            f"expected {INTERNAL_SAMPLE_RATE} Hz inside the pipeline, got {frame.sample_rate} Hz"
        )
    return frame
