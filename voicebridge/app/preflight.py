"""Talk to every configured vendor once, before a call, and report who works.

The M0 failure mode is a vendor rejecting us mid-call: the session dies, both
sockets close, and the caller hears the line drop half a second in with no
clue why. This does the same handshakes without a phone call, so the answer
takes seconds instead of a call attempt.

Nothing here prints a key, and no audio is written anywhere.
"""

import asyncio
import functools
import os
from collections.abc import Mapping
from dataclasses import dataclass

from app.api.ws_transport import dial
from app.providers.asr.deepgram import DeepgramASR, DeepgramConfig
from app.providers.asr.speechmatics import SpeechmaticsASR, SpeechmaticsConfig
from app.providers.base import ASROptions, VoiceSpec
from app.providers.mt.openai_chat import OpenAIConfig, OpenAITranslator
from app.providers.tts.cartesia import CartesiaConfig, CartesiaTTS

TIMEOUT_S = 20.0


@dataclass(frozen=True, slots=True)
class Check:
    vendor: str
    ok: bool
    detail: str


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


async def check_speechmatics(env: Mapping[str, str] | None = None) -> Check:
    try:
        config = SpeechmaticsConfig.from_env(env)
        asr = SpeechmaticsASR(
            functools.partial(dial, config.endpoint, config.auth_headers()),
            config,
            max_redials=0,
        )
        await asyncio.wait_for(asr.open("he", ASROptions()), TIMEOUT_S)
        await asr.close()
    except Exception as exc:
        return Check("Speechmatics (he)", False, f"{type(exc).__name__}: {exc}")
    return Check("Speechmatics (he)", True, "RecognitionStarted received")


async def check_deepgram(env: Mapping[str, str] | None = None) -> Check | None:
    if not _env(env).get("DEEPGRAM_API_KEY"):
        return None
    try:
        config = DeepgramConfig.from_env(env)
        url = config.stream_url("en", ASROptions())
        asr = DeepgramASR(functools.partial(dial, url, config.auth_headers()), max_redials=0)
        await asyncio.wait_for(asr.open("en", ASROptions()), TIMEOUT_S)
        await asr.close()
    except Exception as exc:
        return Check("Deepgram (en)", False, f"{type(exc).__name__}: {exc}")
    return Check("Deepgram (en)", True, "stream opened")


def _http_detail(exc: Exception) -> str:
    """Pull the vendor's own error code out of the body.

    A bare status is misleading here: OpenAI answers both 'you are going too
    fast' and 'this account has no credit' with 429, and the two need
    completely different fixes.
    """
    response = getattr(exc, "response", None)
    if response is None:
        return f"{type(exc).__name__}: {exc}"
    try:
        error = response.json().get("error", {})
    except Exception:
        return f"HTTP {response.status_code}"
    code = str(error.get("code") or error.get("type") or "")
    message = str(error.get("message") or "")[:160]
    if code == "insufficient_quota":
        return f"HTTP {response.status_code} {code} — the account has no credit balance"
    return f"HTTP {response.status_code} {code} {message}".strip()


async def check_openai(env: Mapping[str, str] | None = None) -> Check:
    translator: OpenAITranslator | None = None
    try:
        translator = OpenAITranslator(OpenAIConfig.from_env(env))
        result = await asyncio.wait_for(
            translator.translate("שלום", "he", "en", [], None, "fast"), TIMEOUT_S
        )
        if not result.text.strip():
            return Check("OpenAI (mt)", False, "empty translation")
    except Exception as exc:
        return Check("OpenAI (mt)", False, _http_detail(exc))
    finally:
        if translator is not None:
            await translator.close()
    return Check("OpenAI (mt)", True, "translated a probe phrase")


async def check_cartesia(env: Mapping[str, str] | None = None) -> Check:
    voice_id = _env(env).get("CARTESIA_VOICE_EN", "")
    if not voice_id:
        return Check("Cartesia (tts)", False, "CARTESIA_VOICE_EN is not set")
    tts: CartesiaTTS | None = None
    try:
        config = CartesiaConfig.from_env(env)
        tts = CartesiaTTS(functools.partial(dial, config.stream_url()), config)
        await asyncio.wait_for(tts.start(), TIMEOUT_S)
        synthesis = tts.synthesize("Hello.", VoiceSpec(voice_id=voice_id, language="en"))
        frames = 0

        async def first_chunk() -> int:
            nonlocal frames
            async for _ in synthesis.frames:
                frames += 1
                if frames == 1:
                    break
            return frames

        await asyncio.wait_for(first_chunk(), TIMEOUT_S)
        if frames == 0:
            return Check("Cartesia (tts)", False, "no audio returned")
    except Exception as exc:
        return Check("Cartesia (tts)", False, f"{type(exc).__name__}: {exc}")
    finally:
        if tts is not None:
            await tts.close()
    return Check("Cartesia (tts)", True, "audio received")


async def run_all(env: Mapping[str, str] | None = None) -> list[Check]:
    results = await asyncio.gather(
        check_speechmatics(env),
        check_deepgram(env),
        check_openai(env),
        check_cartesia(env),
    )
    return [check for check in results if check is not None]


def render(checks: list[Check]) -> str:
    lines = [("  ok   " if c.ok else "  FAIL ") + f"{c.vendor:<20} {c.detail}" for c in checks]
    failed = [c for c in checks if not c.ok]
    lines.append("")
    if failed:
        lines.append("Not ready: " + ", ".join(c.vendor for c in failed))
    else:
        lines.append("All vendors answered. The pipeline can run a call.")
    return "\n".join(lines)
