"""G.711 mu-law codec, used only at the telephony boundary (ADR-002).

ADR-002 mandates stdlib ``audioop`` for the mu-law codec. It is deprecated in
3.12 and removed in 3.13, which pins this project to 3.12 until SPEC.md §11 is
amended with a replacement — flagged in the M1 report.
"""

import warnings

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import audioop

_SAMPLE_WIDTH = 2  # PCM16


def mulaw_decode(data: bytes) -> bytes:
    """8-bit mu-law bytes -> PCM16LE bytes at the same sample rate."""
    return audioop.ulaw2lin(data, _SAMPLE_WIDTH)


def mulaw_encode(pcm: bytes) -> bytes:
    """PCM16LE bytes -> 8-bit mu-law bytes at the same sample rate."""
    return audioop.lin2ulaw(pcm, _SAMPLE_WIDTH)
