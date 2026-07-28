"""Control plane and media endpoints (SPEC §3.1).

Routes:
    GET  /health          liveness plus how many operators are waiting
    POST /twilio/voice    inbound-call webhook, answers with TwiML
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

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, PlainTextResponse, Response

from app.api.factory import CALLER_LANGUAGE, OPERATOR_LANGUAGE, build_session
from app.api.feed import OperatorFeed
from app.api.pool import OperatorPool, WaitingOperator
from app.api.twiml import connect_stream, media_stream_url, reject
from app.api.ws_transport import ServerSocket
from app.env_check import blocking, check, load_env_file
from app.observability.events import EventBus, JsonLinesSink
from app.telephony.base import CallContext
from app.telephony.twilio import TwilioAdapter

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


def _pool(request_app: FastAPI) -> OperatorPool:
    pool = request_app.state.pool
    assert isinstance(pool, OperatorPool)
    return pool


@app.get("/health", response_class=PlainTextResponse)
async def health() -> str:
    return f"ok operators_waiting={_pool(app).available}"


@app.get("/operator", response_class=FileResponse)
async def operator_page() -> FileResponse:
    return FileResponse(CONSOLE_PAGE, media_type="text/html")


@app.post("/twilio/voice")
async def inbound_call(request: Request) -> Response:
    if _pool(app).available == 0:
        return Response(content=reject(NO_OPERATOR_MESSAGE), media_type="application/xml")
    host = request.headers.get("x-forwarded-host") or request.url.hostname or ""
    url = media_stream_url(f"https://{host}")
    return Response(content=connect_stream(url), media_type="application/xml")


@app.websocket("/ws/operator")
async def operator_socket(ws: WebSocket) -> None:
    await ws.accept()
    pool = _pool(app)
    operator = pool.register(ServerSocket(ws))
    try:
        # Hold the connection open until a call claims it, then until the
        # call ends — the adapter, not this handler, owns the socket
        # in between.
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
        operator.released.set()


async def _run_call(caller: ServerSocket, operator: WaitingOperator) -> None:
    session_id = uuid.uuid4().hex
    feed = OperatorFeed()
    events = EventBus(session_id, (JsonLinesSink(sys.stdout), feed))
    adapter = TwilioAdapter(caller, operator.ws)
    context = CallContext(
        session_id=session_id,
        caller_language=CALLER_LANGUAGE,
        operator_language=OPERATOR_LANGUAGE,
    )
    legs = await adapter.accept_call(context)
    session = await build_session(adapter, legs, context, events)
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(_pump_feed(feed, operator))
            tg.create_task(_run_and_stop_feed(session.orchestrator.run(), feed))
    except* Exception as group:
        for error in group.exceptions:
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
