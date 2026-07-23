"""CallSession — пара «клиент (Twilio) ↔ оператор (браузер)».

Half-duplex (walkie-talkie):
  - пока пайплайн одной стороны обрабатывает/проигрывает реплику,
    входящие реплики другой стороны становятся в очередь;
  - оригинальный голос собеседнику не транслируется — только перевод;
  - оператор дополнительно получает JSON-транскрипт обоих направлений.

Протокол к Twilio: media-события base64 μ-law 8k, ответ — event=media
с чанками по 20ms + mark для отслеживания конца проигрывания.
Протокол к оператору: бинарные фреймы = PCM16 @16k, текстовые = JSON.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid

import numpy as np

from . import audio as A
from .pipelines.base import TranslationPipeline
from .services.vad import SileroVAD, UtteranceDetector

log = logging.getLogger(__name__)

_TWILIO_CHUNK = 160  # 20ms @ 8k


class CallSession:
    def __init__(self, cfg: dict, he_en: TranslationPipeline, en_he: TranslationPipeline):
        self.id = uuid.uuid4().hex[:8]
        self.cfg = cfg
        self.he_en = he_en
        self.en_he = en_he

        vcfg = cfg["vad"]
        self.det_client = UtteranceDetector(
            SileroVAD(vcfg["threshold"]), vcfg["min_silence_ms"],
            vcfg["min_speech_ms"], vcfg["max_utterance_s"])
        self.det_operator = UtteranceDetector(
            SileroVAD(vcfg["threshold"]), vcfg["min_silence_ms"],
            vcfg["min_speech_ms"], vcfg["max_utterance_s"])

        self.twilio_ws = None          # fastapi WebSocket
        self.operator_ws = None
        self.stream_sid: str | None = None

        self._turn = asyncio.Lock()    # half-duplex: одна реплика в полёте
        self._tasks: set[asyncio.Task] = set()

    # ---------------------------------------------------------- attach legs

    def attach_twilio(self, ws, stream_sid: str):
        self.twilio_ws = ws
        self.stream_sid = stream_sid

    def attach_operator(self, ws):
        self.operator_ws = ws

    @property
    def ready(self) -> bool:
        return self.twilio_ws is not None and self.operator_ws is not None

    # ---------------------------------------------------------- inbound audio

    async def on_twilio_media(self, payload_b64: str):
        chunk = A.twilio_in(base64.b64decode(payload_b64),
                            self.cfg["audio"]["pipeline_rate"])
        utterance = self.det_client.push(chunk)
        if utterance is not None:
            self._spawn(self._handle_turn(utterance, self.he_en))

    async def on_operator_audio(self, pcm16: bytes):
        chunk = A.pcm16_to_float(pcm16)
        utterance = self.det_operator.push(chunk)
        if utterance is not None:
            self._spawn(self._handle_turn(utterance, self.en_he))

    # ---------------------------------------------------------- turn handling

    async def _handle_turn(self, utterance: np.ndarray, pipe: TranslationPipeline):
        async with self._turn:  # walkie-talkie: строго по одной реплике
            try:
                result = await pipe.process(utterance)
            except Exception:
                log.exception("[%s] pipeline %s→%s failed", self.id, pipe.src, pipe.dst)
                return
            if result.audio.size == 0:
                return

            await self._send_transcript(pipe.src, result)
            if pipe.dst == "en":
                await self._play_to_operator(result.audio, result.sample_rate)
            else:
                await self._play_to_twilio(result.audio, result.sample_rate)

    # ---------------------------------------------------------- outbound audio

    async def _play_to_operator(self, x: np.ndarray, rate: int):
        if self.operator_ws is None:
            return
        x = A.resample(x, rate, self.cfg["audio"]["operator_rate"])
        await self.operator_ws.send_bytes(A.float_to_pcm16(x))

    async def _play_to_twilio(self, x: np.ndarray, rate: int):
        if self.twilio_ws is None:
            return
        mulaw = A.twilio_out(x, rate)
        # Twilio принимает произвольные размеры, но шлём по 20ms — ровнее jitter
        for i in range(0, len(mulaw), _TWILIO_CHUNK):
            await self.twilio_ws.send_text(json.dumps({
                "event": "media",
                "streamSid": self.stream_sid,
                "media": {"payload": base64.b64encode(
                    mulaw[i:i + _TWILIO_CHUNK]).decode()},
            }))
        await self.twilio_ws.send_text(json.dumps({
            "event": "mark", "streamSid": self.stream_sid,
            "mark": {"name": f"eot-{uuid.uuid4().hex[:6]}"},
        }))

    async def _send_transcript(self, src: str, result):
        if self.operator_ws is None:
            return
        await self.operator_ws.send_text(json.dumps({
            "type": "transcript",
            "from": "client" if src == "he" else "operator",
            "source_text": result.source_text,
            "translated_text": result.translated_text,
        }, ensure_ascii=False))

    async def notify_status(self, status: str):
        if self.operator_ws is not None:
            await self.operator_ws.send_text(json.dumps(
                {"type": "status", "status": status}))

    # ---------------------------------------------------------- lifecycle

    def _spawn(self, coro):
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def close(self):
        for t in self._tasks:
            t.cancel()
        await self.notify_status("ended")


class SessionManager:
    """MVP: один оператор, одна активная сессия. Очередь звонков — v2."""

    def __init__(self, cfg: dict, he_en: TranslationPipeline, en_he: TranslationPipeline):
        self.cfg, self.he_en, self.en_he = cfg, he_en, en_he
        self.current: CallSession | None = None

    def new_session(self) -> CallSession:
        self.current = CallSession(self.cfg, self.he_en, self.en_he)
        return self.current

    def get(self) -> CallSession | None:
        return self.current
