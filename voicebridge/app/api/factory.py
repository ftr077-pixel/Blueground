"""Assemble one call's pipeline from environment configuration.

This is the only place where concrete vendors are named. Everything below it
sees the §6 protocols.
"""

import functools
import os
from collections.abc import Mapping
from dataclasses import dataclass

from app.api.ws_transport import dial
from app.audio.vad import SileroVad
from app.config import DuplexConfig, SegmenterConfig
from app.observability.events import EventBus
from app.pipeline.languages import ENGLISH, HEBREW
from app.pipeline.orchestrator import DirectionPipeline, SessionOrchestrator
from app.pipeline.segmenter import Segmenter
from app.providers.asr.deepgram import DeepgramASR, DeepgramConfig
from app.providers.asr.speechmatics import SpeechmaticsASR, SpeechmaticsConfig
from app.providers.base import ASROptions, VoiceSpec
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


def _english_asr(env: Mapping[str, str] | None) -> DeepgramASR:
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
    segmenter_config = SegmenterConfig.from_env(env)

    pipelines = (
        DirectionPipeline(
            direction="a2b",
            source_lang=CALLER_LANGUAGE,
            target_lang=OPERATOR_LANGUAGE,
            asr=_hebrew_asr(env),
            vad=SileroVad(),
            segmenter=Segmenter(segmenter_config, HEBREW),
            tts=tts,
            voice=VoiceSpec(voice_id=voices.english_voice_id, language=OPERATOR_LANGUAGE),
        ),
        DirectionPipeline(
            direction="b2a",
            source_lang=OPERATOR_LANGUAGE,
            target_lang=CALLER_LANGUAGE,
            asr=_english_asr(env),
            vad=SileroVad(),
            segmenter=Segmenter(segmenter_config, ENGLISH),
            tts=tts,
            voice=VoiceSpec(voice_id=voices.hebrew_voice_id, language=CALLER_LANGUAGE),
        ),
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
