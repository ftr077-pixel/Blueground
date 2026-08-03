"""Assemble one call's pipeline from environment configuration.

This is the only place where concrete vendors are named. Everything below it
sees the §6 protocols.
"""

import functools
import os
from collections.abc import Mapping
from dataclasses import dataclass

from app.api.ws_transport import dial
from app.audio.vad import EnergyVad
from app.config import DuplexConfig, SegmenterConfig
from app.observability.events import EventBus
from app.pipeline.languages import ENGLISH, HEBREW
from app.pipeline.orchestrator import DirectionPipeline, SessionOrchestrator
from app.pipeline.segmenter import Segmenter
from app.providers.asr.deepgram import DeepgramASR, DeepgramConfig
from app.providers.asr.speechmatics import SpeechmaticsASR, SpeechmaticsConfig
from app.providers.base import ASROptions, ASRProvider, VoiceSpec
from app.providers.mt.openai_chat import OpenAIConfig, OpenAITranslator
from app.providers.tts.cartesia import CartesiaConfig, CartesiaTTS
from app.telephony.base import CallContext, CallLegs
from app.telephony.twilio import TwilioAdapter

CALLER_LANGUAGE = "he"
OPERATOR_LANGUAGE = "en"


@dataclass(frozen=True, slots=True)
class VoiceConfig:
    hebrew_voice_id: str
    english_voice_id: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "VoiceConfig":
        e = os.environ if env is None else env
        hebrew, english = e.get("CARTESIA_VOICE_HE"), e.get("CARTESIA_VOICE_EN")
        if not hebrew or not english:
            raise RuntimeError("CARTESIA_VOICE_HE and CARTESIA_VOICE_EN must be set")
        return cls(hebrew_voice_id=hebrew, english_voice_id=english)


@dataclass(slots=True)
class Session:
    orchestrator: SessionOrchestrator
    tts: CartesiaTTS
    translator: OpenAITranslator

    async def aclose(self) -> None:
        await self.tts.close()
        await self.translator.close()


def _hebrew_asr(env: Mapping[str, str] | None) -> SpeechmaticsASR:
    config = SpeechmaticsConfig.from_env(env)
    return SpeechmaticsASR(functools.partial(dial, config.endpoint, config.auth_headers()), config)


def _english_asr(env: Mapping[str, str] | None) -> ASRProvider | None:
    """Deepgram for the operator side, or nothing.

    Measured on a live call: pointing both directions at Speechmatics opens
    two concurrent streams and a starter plan allows one, so every call died
    with 'Concurrent Quota Exceeded'. Without a second vendor the honest
    behaviour is M0's half-duplex (SPEC §9) rather than a call that cannot
    start. ADR-003 wanted Deepgram here anyway.
    """
    e = os.environ if env is None else env
    if not e.get("DEEPGRAM_API_KEY"):
        return None
    config = DeepgramConfig.from_env(env)
    url = config.stream_url(OPERATOR_LANGUAGE, ASROptions())
    return DeepgramASR(functools.partial(dial, url, config.auth_headers()))


async def build_session(
    adapter: TwilioAdapter,
    legs: CallLegs,
    context: CallContext,
    events: EventBus,
    env: Mapping[str, str] | None = None,
) -> Session:
    voices = VoiceConfig.from_env(env)
    tts_config = CartesiaConfig.from_env(env)
    tts = CartesiaTTS(functools.partial(dial, tts_config.stream_url()), tts_config)
    await tts.start()

    translator = OpenAITranslator(OpenAIConfig.from_env(env))
    # Before the caller says anything, so the first turn does not pay for
    # the TLS handshake while somebody listens to silence.
    await translator.warm()
    segmenter_config = SegmenterConfig.from_env(env)

    english_asr = _english_asr(env)
    pipelines = [
        DirectionPipeline(
            direction="a2b",
            source_lang=CALLER_LANGUAGE,
            target_lang=OPERATOR_LANGUAGE,
            asr=_hebrew_asr(env),
            vad=EnergyVad(),
            segmenter=Segmenter(segmenter_config, HEBREW),
            tts=tts,
            voice=VoiceSpec(voice_id=voices.english_voice_id, language=OPERATOR_LANGUAGE),
        )
    ]
    if english_asr is not None:
        pipelines.append(
            DirectionPipeline(
                direction="b2a",
                source_lang=OPERATOR_LANGUAGE,
                target_lang=CALLER_LANGUAGE,
                asr=english_asr,
                vad=EnergyVad(),
                segmenter=Segmenter(segmenter_config, ENGLISH),
                tts=tts,
                voice=VoiceSpec(voice_id=voices.hebrew_voice_id, language=CALLER_LANGUAGE),
            )
        )
    orchestrator = SessionOrchestrator(
        session_id=context.session_id,
        adapter=adapter,
        legs=legs,
        pipelines=pipelines,
        translator=translator,
        events=events,
        segmenter_config=segmenter_config,
        duplex_config=DuplexConfig.from_env(env),
    )
    return Session(orchestrator=orchestrator, tts=tts, translator=translator)
