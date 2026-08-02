"""Control plane and media endpoints (SPEC §3.1).

Routes:
    GET  /health          liveness plus how many operators are waiting
    POST /twilio/voice    inbound-call webhook, answers with TwiML
    POST /call            ring a number and bridge it in (SPEC A7)
    WS   /ws/twilio       the call's audio, Twilio Media Streams protocol
    WS   /ws/operator     the console: PCM16 16 kHz audio plus a JSON feed
    GET  /operator        the console page

M0 pairs one call with one waiting operator (SPEC §9). Concurrency, auth and
the real console are later milestones.
"""

import asyncio
import contextlib
import logging
import os
import sys
import uuid
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

from app.api.factory import CALLER_LANGUAGE, OPERATOR_LANGUAGE, build_session
from app.api.feed import OperatorFeed
from app.api.outbound import allowlist, normalise
from app.api.pool import OperatorPool, WaitingOperator
from app.api.ws_transport import ServerSocket
from app.env_check import blocking, check, load_env_file
from app.observability.events import EventBus, JsonLinesSink
from app.observability.trace import CallTrace
from app.telephony.base import CallContext
from app.telephony.twilio import TwilioAdapter
from app.telephony.twilio_rest import TwilioDialer, TwilioRestConfig
from app.telephony.twiml import connect_stream, media_stream_url, reject
from app.transport import MessageStream

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_PAGE = REPO_ROOT / "app" / "console" / "index.html"
ENV_FILE = REPO_ROOT / ".env"
NO_OPERATOR_MESSAGE = "No operator is available right now. Please call back shortly."

log = logging.getLogger("voicebridge")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Configuration is validated here, not on the first call: a missing key
    # must stop the server from starting, never drop a caller mid-connect.
    loaded = load_env_file(ENV_FILE)
    if loaded:
        log.info("loaded %d values from %s", len(loaded), ENV_FILE)
    problems = blocking(check(dict(os.environ)))
    if problems:
        names = ", ".join(problem.name for problem in problems)
        raise RuntimeError(f"configuration incomplete: {names}. Run 'make check-env'.")
    yield


app = FastAPI(title="VoiceBridge", lifespan=lifespan)
app.state.pool = OperatorPool()
app.state.trace = CallTrace()


def _pool(request_app: FastAPI) -> OperatorPool:
    pool = request_app.state.pool
    assert isinstance(pool, OperatorPool)
    return pool


@app.get("/health", response_class=PlainTextResponse)
async def health() -> str:
    return f"ok operators_waiting={_pool(app).available}"


@app.get("/debug/last-call")
async def last_call() -> dict[str, object]:
    """Per-stage waterfall for the most recent call (SPEC §7).

    Contains transcripts, so it is a debugging aid, not a public endpoint —
    it goes behind auth with the rest of the control plane at M2.
    """
    trace = app.state.trace
    assert isinstance(trace, CallTrace)
    return trace.summary()


@app.get("/operator", response_class=FileResponse)
async def operator_page() -> FileResponse:
    return FileResponse(CONSOLE_PAGE, media_type="text/html")


@app.post("/twilio/voice")
async def inbound_call(request: Request) -> Response:
    if _pool(app).available == 0:
        return Response(content=reject(NO_OPERATOR_MESSAGE), media_type="application/xml")
    url = media_stream_url(_public_host(request))
    return Response(content=connect_stream(url), media_type="application/xml")


def _public_host(request: Request) -> str:
    """The address Twilio must dial back on.

    Behind a tunnel the request's own hostname is localhost, so the forwarded
    header comes first and PUBLIC_HOST is the manual override for anything
    that does not set one.
    """
    configured = os.environ.get("PUBLIC_HOST", "").strip().rstrip("/")
    if configured:
        return configured
    host = request.headers.get("x-forwarded-host") or request.url.hostname or ""
    return f"https://{host}"


@app.post("/call")
async def place_call(request: Request) -> Response:
    """Ring a number and bridge it into the waiting operator (SPEC A7).

    Fail-closed on the allowlist: this endpoint is on a public tunnel with no
    auth until M2, and an open dial endpoint is somebody else's phone bill.
    """
    payload = await request.json()
    number = normalise(str(payload.get("to", "")))
    if number is None:
        return JSONResponse({"detail": "not a phone number in international format"}, 400)
    allowed = allowlist()
    if not allowed:
        return JSONResponse({"detail": "outbound calling is off — set OUTBOUND_ALLOWED"}, 403)
    if number not in allowed:
        return JSONResponse({"detail": "this number is not in OUTBOUND_ALLOWED"}, 403)
    if _pool(app).available == 0:
        # The dialled party would otherwise hear silence and hang up.
        return JSONResponse({"detail": "connect the console before placing a call"}, 409)
    try:
        config = TwilioRestConfig.from_env()
        async with httpx.AsyncClient() as client:
            sid = await TwilioDialer(config, client).dial(
                number, media_stream_url(_public_host(request))
            )
    except Exception as exc:
        log.exception("outbound call failed")
        return JSONResponse({"detail": str(exc)}, 502)
    log.info("placed outbound call %s", sid)
    return JSONResponse({"sid": sid}, 201)


DRAIN_TICK_S = 0.05


@app.websocket("/ws/operator")
async def operator_socket(ws: WebSocket) -> None:
    await ws.accept()
    pool = _pool(app)
    stream = ServerSocket(ws)
    operator = pool.register(stream)
    try:
        # Audio arriving before a call is stale by the time a caller
        # connects, so it is read and dropped rather than left to pile up in
        # the socket buffer. Reading also surfaces a closed tab, which an
        # idle handler would never notice.
        while not operator.claimed.is_set():
            try:
                message = await asyncio.wait_for(stream.recv(), DRAIN_TICK_S)
            except TimeoutError:
                continue
            if message is None:
                return
        # From here the adapter owns the socket; just keep the handler alive
        # so the connection stays open for the duration of the call.
        await operator.released.wait()
    finally:
        pool.drop(operator)


@app.websocket("/ws/twilio")
async def twilio_socket(ws: WebSocket) -> None:
    await ws.accept()
    caller = ServerSocket(ws)
    operator = _pool(app).claim()
    if operator is None:
        log.warning("call arrived with no operator waiting")
        await caller.close()
        return
    try:
        await _run_call(caller, operator)
    finally:
        # One socket per call: the console reconnects and re-registers, which
        # leaves no half-alive registration behind when a call ends badly.
        operator.released.set()
        with contextlib.suppress(Exception):
            await operator.ws.close()
        with contextlib.suppress(Exception):
            await caller.close()


async def _run_call(caller: MessageStream, operator: WaitingOperator) -> None:
    session_id = uuid.uuid4().hex
    feed = OperatorFeed()
    trace = app.state.trace
    assert isinstance(trace, CallTrace)
    events = EventBus(session_id, (JsonLinesSink(sys.stdout), feed, trace))
    adapter = TwilioAdapter(caller, operator.ws)
    context = CallContext(
        session_id=session_id,
        caller_language=CALLER_LANGUAGE,
        operator_language=OPERATOR_LANGUAGE,
    )
    legs = await adapter.accept_call(context)
    try:
        session = await build_session(adapter, legs, context, events)
    except Exception as exc:
        # A vendor refusing the session (bad key, quota, unknown voice) must
        # leave a trace, or /debug/last-call shows an empty call and the reason
        # lives only in the journal.
        events.emit("error", stage="session_setup", detail=repr(exc))
        log.exception("call %s could not start", session_id, exc_info=exc)
        return
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_pump_feed(feed, operator))
            tg.create_task(_run_and_stop_feed(session.orchestrator.run(), feed))
    except* Exception as group:
        for error in group.exceptions:
            events.emit("error", stage="call", detail=repr(error))
            log.exception("call %s failed", session_id, exc_info=error)
    finally:
        await session.aclose()


async def _run_and_stop_feed(run: Coroutine[None, None, None], feed: OperatorFeed) -> None:
    try:
        await run
    finally:
        feed.stop()


async def _pump_feed(feed: OperatorFeed, operator: WaitingOperator) -> None:
    while True:
        line = await feed.queue.get()
        if line is None:
            return
        with contextlib.suppress(ConnectionError):
            await operator.ws.send(line)
