"""Аудио-конвертация: Twilio μ-law 8k ⇄ PCM16 float, ресемплинг.

Внутренний формат пайплайнов: mono float32 numpy array, 16 kHz, [-1, 1].
"""
from __future__ import annotations

import numpy as np
from scipy.signal import resample_poly

# --- μ-law (G.711) ---------------------------------------------------------

_MU = 255.0


def mulaw_decode(data: bytes) -> np.ndarray:
    """bytes μ-law → float32 [-1,1] @ 8kHz."""
    u = np.frombuffer(data, dtype=np.uint8).astype(np.float32)
    u = ~u.astype(np.uint8)  # μ-law хранится инвертированным
    u = u.astype(np.float32)
    sign = np.where(u >= 128, -1.0, 1.0)
    mag = np.where(u >= 128, u - 128, u)
    x = sign * ((1.0 + _MU) ** (mag / 127.0) - 1.0) / _MU
    return x.astype(np.float32)


def mulaw_encode(x: np.ndarray) -> bytes:
    """float32 [-1,1] @ 8kHz → bytes μ-law."""
    x = np.clip(x, -1.0, 1.0)
    sign = np.where(x < 0, 128, 0).astype(np.uint8)
    mag = np.log1p(_MU * np.abs(x)) / np.log1p(_MU)  # [0,1]
    q = np.round(mag * 127.0).astype(np.uint8)
    u = (sign | q).astype(np.uint8)
    return (~u).tobytes()


# --- PCM16 -----------------------------------------------------------------

def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def float_to_pcm16(x: np.ndarray) -> bytes:
    x = np.clip(x, -1.0, 1.0)
    return (x * 32767.0).astype(np.int16).tobytes()


# --- Resampling ------------------------------------------------------------

def resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate:
        return x
    g = np.gcd(src_rate, dst_rate)
    return resample_poly(x, dst_rate // g, src_rate // g).astype(np.float32)


# --- Convenience: конверсии концов трубы -----------------------------------

def twilio_in(data: bytes, pipeline_rate: int = 16000) -> np.ndarray:
    """Twilio media payload (μ-law 8k) → float32 @ pipeline_rate."""
    return resample(mulaw_decode(data), 8000, pipeline_rate)


def twilio_out(x: np.ndarray, src_rate: int) -> bytes:
    """float32 @ src_rate → μ-law 8k для отправки в Twilio."""
    return mulaw_encode(resample(x, src_rate, 8000))
