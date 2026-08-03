"""Vendor latency probe (SPEC §8.4).

Measures what each vendor actually costs us, against the live APIs, so that
"the translation is slow" becomes a number attached to a stage. One live call
gives three samples and a hypothesis; this gives a distribution.

The cold/warm split for MT exists because the first request of a call pays for
DNS and the TLS handshake, and a call has exactly one first request — the one
the caller is waiting on.
"""

import asyncio
import functools
import statistics
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from app.api.ws_transport import dial
from app.providers.asr.speechmatics import SpeechmaticsASR, SpeechmaticsConfig
from app.providers.base import ASROptions, VoiceSpec
from app.providers.mt.openai_chat import OpenAIConfig, OpenAITranslator
from app.providers.tts.cartesia import CartesiaConfig, CartesiaTTS

PROBE_HEBREW = "אני רוצה להזמין חדר"
PROBE_ENGLISH = "I would like to book a room"


@dataclass(slots=True)
class Measurement:
    stage: str
    samples: list[float] = field(default_factory=list)
    error: str = ""

    def add(self, ms: float) -> None:
        self.samples.append(ms)

    @property
    def p50(self) -> float | None:
        return round(statistics.median(self.samples), 1) if self.samples else None

    @property
    def p95(self) -> float | None:
        if not self.samples:
            return None
        ordered = sorted(self.samples)
        return round(ordered[max(0, round(0.95 * len(ordered)) - 1)], 1)

    @property
    def worst(self) -> float | None:
        return round(max(self.samples), 1) if self.samples else None


async def probe_mt_warm(rounds: int, env: Mapping[str, str] | None = None) -> Measurement:
    """One client for every round — what turns 2..n of a call pay."""
    measurement = Measurement("MT warm (gpt-4o-mini)")
    translator = OpenAITranslator(OpenAIConfig.from_env(env))
    try:
        for _ in range(rounds):
            started = time.monotonic()
            await translator.translate(
                PROBE_HEBREW, "he", "en", context=[], glossary=None, tier="fast"
            )
            measurement.add((time.monotonic() - started) * 1000.0)
    except Exception as exc:
        measurement.error = f"{type(exc).__name__}: {exc}"
    finally:
        await translator.close()
    return measurement


async def probe_mt_cold(rounds: int, env: Mapping[str, str] | None = None) -> Measurement:
    """A fresh connection each round — what the first turn of a call pays."""
    measurement = Measurement("MT cold (first turn of a call)")
    config = OpenAIConfig.from_env(env)
    try:
        for _ in range(rounds):
            translator = OpenAITranslator(config)
            started = time.monotonic()
            try:
                await translator.translate(
                    PROBE_HEBREW, "he", "en", context=[], glossary=None, tier="fast"
                )
                measurement.add((time.monotonic() - started) * 1000.0)
            finally:
                await translator.close()
    except Exception as exc:
        measurement.error = f"{type(exc).__name__}: {exc}"
    return measurement


async def probe_tts(rounds: int, env: Mapping[str, str] | None = None) -> Measurement:
    """Time to the first audio chunk — what the §5 budget actually spends."""
    measurement = Measurement("TTS first chunk")
    config = CartesiaConfig.from_env(env)
    voice = (env or {}).get("CARTESIA_VOICE_EN") or _env_value("CARTESIA_VOICE_EN")
    if not voice:
        measurement.error = "CARTESIA_VOICE_EN is not set"
        return measurement
    tts = CartesiaTTS(functools.partial(dial, config.stream_url()), config)
    try:
        await tts.start()
        for _ in range(rounds):
            started = time.monotonic()
            synthesis = tts.synthesize(PROBE_ENGLISH, VoiceSpec(voice_id=voice, language="en"))
            async for _frame in synthesis.frames:
                measurement.add((time.monotonic() - started) * 1000.0)
                break
            await tts.cancel(synthesis.handle)
    except Exception as exc:
        measurement.error = f"{type(exc).__name__}: {exc}"
    finally:
        await tts.close()
    return measurement


async def probe_asr_handshake(rounds: int, env: Mapping[str, str] | None = None) -> Measurement:
    """Connect plus StartRecognition — paid once per call, before anyone speaks."""
    measurement = Measurement("ASR handshake (Speechmatics)")
    config = SpeechmaticsConfig.from_env(env)
    try:
        for _ in range(rounds):
            asr = SpeechmaticsASR(
                functools.partial(dial, config.endpoint, config.auth_headers()),
                config,
                max_redials=0,
            )
            started = time.monotonic()
            try:
                await asr.open("he", ASROptions())
                measurement.add((time.monotonic() - started) * 1000.0)
            finally:
                await asr.close()
    except Exception as exc:
        measurement.error = f"{type(exc).__name__}: {exc}"
    return measurement


def _env_value(name: str) -> str:
    import os

    return os.environ.get(name, "")


async def run_all(rounds: int = 5, env: Mapping[str, str] | None = None) -> list[Measurement]:
    # Sequential on purpose: probes run against the same vendors a live call
    # uses, and Speechmatics' starter plan allows one concurrent stream.
    return [
        await probe_asr_handshake(rounds, env),
        await probe_mt_cold(rounds, env),
        await probe_mt_warm(rounds, env),
        await probe_tts(rounds, env),
    ]


def render(measurements: Sequence[Measurement], budget_ms: float = 1500.0) -> str:
    lines = [f"{'stage':<34} {'p50':>9} {'p95':>9} {'max':>9}   n", "-" * 74]
    for m in measurements:
        if m.error:
            lines.append(f"{m.stage:<34} {m.error}")
            continue
        lines.append(
            f"{m.stage:<34} {_ms(m.p50):>9} {_ms(m.p95):>9} {_ms(m.worst):>9}   {len(m.samples)}"
        )
    warm = next((m for m in measurements if m.stage.startswith("MT warm")), None)
    tts = next((m for m in measurements if m.stage.startswith("TTS")), None)
    lines.append("")
    if warm and warm.p50 and tts and tts.p50:
        total = warm.p50 + tts.p50
        verdict = "within" if total <= budget_ms else "OVER"
        lines.append(
            f"MT + TTS at p50 is {round(total)} ms — {verdict} the {round(budget_ms)} ms "
            "budget of SPEC §5, before our own overhead."
        )
    return "\n".join(lines)


def _ms(value: float | None) -> str:
    return "—" if value is None else f"{value:.0f} ms"


async def main(rounds: int = 5) -> str:
    return render(await run_all(rounds))


if __name__ == "__main__":  # pragma: no cover
    print(asyncio.run(main()))
