"""Twilio Media Streams adapter (ADR-001, milestone M0).

One instance per call. The caller leg is a Twilio bidirectional
``<Connect><Stream>`` WebSocket carrying base64 mu-law at 8 kHz; the operator
leg is a plain browser WebSocket carrying binary 16 kHz mono PCM16LE frames.
All transcoding happens here — nothing past this boundary sees mu-law or 8 kHz
(ADR-002).

Operator wire protocol: binary messages are audio in internal format, both
directions. The only JSON control message we send is ``{"event": "clear"}``,
telling the client to drop its playback buffer on barge-in.

The transport is injected as a ``MessageStream`` so the adapter is fully
testable offline; the API layer adapts a real websocket connection to it.
No reconnect logic here: if either call-carrying socket dies, the call is
over — reconnect-and-resume belongs to vendor streams (ASR/TTS), not to the
telephony legs.
"""

import base64
import json
from collections.abc import AsyncIterator
from typing import Protocol

from app.audio.codecs import mulaw_decode, mulaw_encode
from app.audio.frames import INTERNAL_SAMPLE_RATE, AudioFrame
from app.audio.resample import StreamResampler
from app.observability.events import monotonic_ms
from app.telephony.base import CallContext, CallLegs, Leg

TWILIO_SAMPLE_RATE = 8000


class MessageStream(Protocol):
    """Minimal duplex message transport (a websocket, stripped to what we use).

    ``recv`` returns ``None`` when the peer closes.
    """

    async def recv(self) -> str | bytes | None: ...
    async def send(self, data: str | bytes) -> None: ...
    async def close(self) -> None: ...


class TwilioHandshakeError(ConnectionError):
    pass


class TwilioAdapter:
    def __init__(self, caller_ws: MessageStream, operator_ws: MessageStream) -> None:
        self._caller_ws = caller_ws
        self._operator_ws = operator_ws
        self._stream_sid: str | None = None
        self._inbound_resampler = StreamResampler(TWILIO_SAMPLE_RATE, INTERNAL_SAMPLE_RATE)
        self._outbound_resampler = StreamResampler(INTERNAL_SAMPLE_RATE, TWILIO_SAMPLE_RATE)

    # --- TelephonyAdapter ---------------------------------------------------

    async def accept_call(self, ctx: CallContext) -> CallLegs:
        # Twilio sends "connected" then "start"; media may not arrive before
        # "start", which carries the streamSid we need for outbound messages.
        while self._stream_sid is None:
            raw = await self._caller_ws.recv()
            if raw is None:
                raise TwilioHandshakeError("twilio closed the stream before 'start'")
            message = json.loads(raw)
            if message.get("event") == "start":
                self._stream_sid = str(message["start"]["streamSid"])
        return CallLegs(
            caller=Leg(id=f"{ctx.session_id}-caller", side="caller"),
            operator=Leg(id=f"{ctx.session_id}-operator", side="operator"),
        )

    def inbound_audio(self, leg: Leg) -> AsyncIterator[AudioFrame]:
        if leg.side == "caller":
            return self._caller_inbound()
        return self._operator_inbound()

    async def send_audio(self, leg: Leg, frame: AudioFrame) -> None:
        if frame.sample_rate != INTERNAL_SAMPLE_RATE:
            raise ValueError(f"send_audio expects internal format, got {frame.sample_rate} Hz")
        if leg.side == "operator":
            await self._operator_ws.send(frame.pcm)
            return
        pcm8k = self._outbound_resampler.process(frame.pcm)
        if not pcm8k:
            return
        payload = base64.b64encode(mulaw_encode(pcm8k)).decode("ascii")
        await self._caller_ws.send(
            json.dumps(
                {
                    "event": "media",
                    "streamSid": self._require_sid(),
                    "media": {"payload": payload},
                }
            )
        )

    async def flush_outbound(self, leg: Leg) -> None:
        if leg.side == "caller":
            # Twilio's "clear" discards its buffered outbound audio — this is
            # what makes the 300 ms barge-in budget reachable over PSTN.
            await self._caller_ws.send(
                json.dumps({"event": "clear", "streamSid": self._require_sid()})
            )
        else:
            await self._operator_ws.send(json.dumps({"event": "clear"}))

    async def hangup(self, leg: Leg) -> None:
        ws = self._caller_ws if leg.side == "caller" else self._operator_ws
        await ws.close()

    # --- internals ----------------------------------------------------------

    def _require_sid(self) -> str:
        if self._stream_sid is None:
            raise TwilioHandshakeError("no streamSid — accept_call has not completed")
        return self._stream_sid

    async def _caller_inbound(self) -> AsyncIterator[AudioFrame]:
        while True:
            raw = await self._caller_ws.recv()
            if raw is None:
                return
            message = json.loads(raw)
            event = message.get("event")
            if event == "media":
                media = message["media"]
                # Bidirectional streams can echo our own outbound track back;
                # only the caller's inbound track may reach the pipeline
                # (ADR-006 feedback guard at the wire).
                if media.get("track", "inbound") != "inbound":
                    continue
                pcm8k = mulaw_decode(base64.b64decode(media["payload"]))
                pcm16k = self._inbound_resampler.process(pcm8k)
                if pcm16k:
                    yield AudioFrame(
                        pcm=pcm16k, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=monotonic_ms()
                    )
            elif event == "stop":
                return

    async def _operator_inbound(self) -> AsyncIterator[AudioFrame]:
        while True:
            raw = await self._operator_ws.recv()
            if raw is None:
                return
            if isinstance(raw, bytes) and raw:
                yield AudioFrame(pcm=raw, sample_rate=INTERNAL_SAMPLE_RATE, ts_ms=monotonic_ms())
            # Text messages from the operator client are ignored for now:
            # there is no inbound control channel at M0.
