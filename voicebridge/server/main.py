"""FastAPI-приложение: три конца трубы.

POST /twilio/voice   — webhook входящего звонка → TwiML <Connect><Stream>
WS   /twilio/stream  — медиапоток Twilio (μ-law 8k, base64)
WS   /operator/ws    — браузер оператора (PCM16 16k + JSON)
GET  /operator       — страница оператора
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("voicebridge")

ROOT = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load((ROOT / "config.yaml").read_text())

app = FastAPI(title="VoiceBridge")

_manager = None  # SessionManager, инициализируется на старте (модели тяжёлые)


@app.on_event("startup")
async def _startup():
    global _manager
    from .call_session import SessionManager
    from .pipelines.cascade import CascadePipeline
    from .services.asr_whisper import WhisperASR
    from .services.mt_qwen import QwenTranslator
    from .services.tts import EnglishTTS, HebrewTTS

    log.info("Loading models…")
    translator = QwenTranslator(  # общий: одна история диалога на оба направления
        system_prompt=CFG["mt"]["system_prompt"],
        temperature=CFG["mt"]["temperature"],
        max_tokens=CFG["mt"]["max_tokens"],
    )
    asr_he = WhisperASR(**{k: v for k, v in CFG["asr"]["hebrew"].items()})
    asr_en = WhisperASR(**{k: v for k, v in CFG["asr"]["english"].items()})
    tts_en = EnglishTTS(voice=CFG["tts"]["english"]["voice"])
    tts_he = HebrewTTS(model=CFG["tts"]["hebrew"]["model"])

    if CFG["pipelines"]["he_en"] == "seamless":
        from .pipelines.seamless import SeamlessPipeline
        he_en = SeamlessPipeline(model=CFG["seamless"]["model"])
    else:
        he_en = CascadePipeline("he", "en", asr_he, translator, tts_en)
    en_he = CascadePipeline("en", "he", asr_en, translator, tts_he)

    _manager = SessionManager(CFG, he_en, en_he)
    log.info("Ready. he_en=%s", CFG["pipelines"]["he_en"])


# ------------------------------------------------------------------ Twilio

@app.post("/twilio/voice")
async def twilio_voice(request: Request):
    # TODO: валидация X-Twilio-Signature (twilio.request_validator)
    host = os.environ["PUBLIC_HOST"]
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://{host}/twilio/stream"/>
  </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


@app.websocket("/twilio/stream")
async def twilio_stream(ws: WebSocket):
    await ws.accept()
    session = None
    try:
        while True:
            msg = await ws.receive_json()
            event = msg.get("event")
            if event == "start":
                stream_sid = msg["start"]["streamSid"]
                session = _manager.get() or _manager.new_session()
                session.attach_twilio(ws, stream_sid)
                await session.notify_status("call_connected")
                log.info("Call started, streamSid=%s session=%s", stream_sid, session.id)
            elif event == "media" and session:
                await session.on_twilio_media(msg["media"]["payload"])
            elif event == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if session:
            await session.close()
        log.info("Call ended")


# ------------------------------------------------------------------ Operator

@app.get("/operator")
async def operator_page():
    return FileResponse(ROOT / "operator-client" / "index.html")


@app.websocket("/operator/ws")
async def operator_ws(ws: WebSocket):
    await ws.accept()
    session = _manager.get() or _manager.new_session()
    session.attach_operator(ws)
    await session.notify_status("operator_connected")
    try:
        while True:
            msg = await ws.receive()
            if "bytes" in msg and msg["bytes"]:
                await session.on_operator_audio(msg["bytes"])
            elif "text" in msg and msg["text"]:
                pass  # управляющие команды из UI (mute и т.п.) — v2
    except WebSocketDisconnect:
        session.operator_ws = None
        log.info("Operator disconnected")
