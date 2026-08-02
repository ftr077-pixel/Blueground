"""Control plane and media endpoints (SPEC §3.1).

Routes:
    GET  /health          liveness plus how many operators are waiting
    POST /twilio/voice    inbound-call webhook, answers with TwiML
    POST /call            ring a number and bridge it in (SPEC A7)
    WS   /ws/twilio       the call's audio, Twilio Media Streams protocol
    WS   /ws/operator     the console: PCM16 16 kHz audio plus a JSON feed
    GET  /operator        the console page
    GET  /calls           past calls, transcripts and summaries (SPEC A9)
    GET  /auth/*          google sign-in for the control plane (SPEC A8)

M0 pairs one call with one waiting operator (SPEC §9). Concurrency, auth and
the real console are later milestones.
"""

import asyncio
import contextlib
import logging
import os
import secrets
import sys
import time
import uuid
from collections.abc import AsyncIterator, Coroutine, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from starlette.middleware.sessions import SessionMiddleware

from app.api.auth import (
    CALLBACK_PATH,
    AuthConfig,
    AuthError,
    authorise,
    authorize_url,
    check_state,
    exchange_code,
    new_state,
)
from app.api.factory import CALLER_LANGUAGE, OPERATOR_LANGUAGE, build_session
from app.api.feed import OperatorFeed
from app.api.outbound import allowlist, normalise
from app.api.pool import OperatorPool, WaitingOperator
from app.api.ws_transport import ServerSocket
from app.env_check import blocking, check, load_env_file
from app.observability.events import EventBus, JsonLinesSink
from app.observability.trace import CallTrace
from app.providers.mt.openai_chat import OpenAIConfig
from app.storage.calls import CallRecord, CallStore, new_call_id
from app.summary import Summariser
from app.telephony.base import CallContext
from app.telephony.twilio import TwilioAdapter
from app.telephony.twilio_rest import TwilioDialer, TwilioRestConfig
from app.telephony.twiml import connect_stream, media_stream_url, reject
from app.transport import MessageStream

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_DIR = REPO_ROOT / "app" / "console"
CONSOLE_PAGE = CONSOLE_DIR / "index.html"
HISTORY_PAGE = CONSOLE_DIR / "calls.html"
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
    if AuthConfig.from_env() is None:
        log.warning(
            "sign-in is NOT configured: /operator, /call and /debug are open to anyone "
            "who can reach this address. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET "
            "and OPERATOR_EMAILS."
        )
    elif not os.environ.get("SESSION_SECRET"):
        log.warning("SESSION_SECRET is unset: every restart signs all operators out")
    days = float(os.environ.get("CALL_RETENTION_DAYS", "90"))
    if days > 0:
        removed = await _store(app).prune(days)
        if removed:
            log.info("pruned %d call records older than %g days", removed, days)
    yield


app = FastAPI(title="VoiceBridge", lifespan=lifespan)
app.state.pool = OperatorPool()
app.state.trace = CallTrace()
# Reported by /health so a deploy can wait for the line to be free instead
# of cutting somebody off mid-sentence.
app.state.active_calls = 0
# Durable call history (SPEC A9). One file, backed up with cp.
app.state.store = CallStore(Path(os.environ.get("CALL_DB", REPO_ROOT / "data" / "calls.db")))
# A regenerated key at restart only signs people out; a key committed to the
# repository would let anyone mint a session, so a missing one is generated.
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET") or secrets.token_urlsafe(32),
    same_site="lax",
    https_only=True,
)


def _pool(request_app: FastAPI) -> OperatorPool:
    pool = request_app.state.pool
    assert isinstance(pool, OperatorPool)
    return pool


def _signed_in(session: Mapping[str, object]) -> bool:
    """True when the request may use the control plane.

    Unconfigured sign-in leaves the console open: a box mid-setup must not
    lock its owner out. The startup check says so out loud.
    """
    if AuthConfig.from_env() is None:
        return True
    return bool(session.get("email"))


@app.get("/health", response_class=PlainTextResponse)
async def health() -> str:
    return f"ok operators_waiting={_pool(app).available} calls_active={app.state.active_calls}"


@app.get("/debug/last-call")
async def last_call(request: Request) -> Response:
    """Per-stage waterfall for the most recent call (SPEC §7).

    Holds transcripts of real conversations, so it sits behind sign-in
    with the rest of the control plane.
    """
    if not _signed_in(request.session):
        return JSONResponse({"detail": "sign in first"}, 401)
    trace = app.state.trace
    assert isinstance(trace, CallTrace)
    return JSONResponse(trace.summary())


@app.get("/operator")
async def operator_page(request: Request) -> Response:
    if not _signed_in(request.session):
        return RedirectResponse("/auth/login")
    return FileResponse(CONSOLE_PAGE, media_type="text/html")


def _store(request_app: FastAPI) -> CallStore:
    store = request_app.state.store
    assert isinstance(store, CallStore)
    return store


def _admins() -> frozenset[str]:
    raw = os.environ.get("ADMIN_EMAILS", "")
    return frozenset(part.strip().casefold() for part in raw.split(",") if part.strip())


def _visible_to(session: Mapping[str, object]) -> str | None:
    """Which operator's calls this session may read; None means all of them.

    Fail closed twice over: an unlisted address sees only its own calls, and
    with sign-in unconfigured there is no email at all, so nothing matches
    and the history is empty rather than everybody's.
    """
    email = str(session.get("email") or "").casefold()
    return None if email and email in _admins() else email


@app.get("/calls")
async def history_page(request: Request) -> Response:
    if not _signed_in(request.session):
        return RedirectResponse("/auth/login")
    return FileResponse(HISTORY_PAGE, media_type="text/html")


@app.get("/api/calls")
async def list_calls(request: Request) -> Response:
    if not _signed_in(request.session):
        return JSONResponse({"detail": "sign in first"}, 401)
    records = await _store(app).recent(_visible_to(request.session))
    return JSONResponse(
        {
            "admin": _visible_to(request.session) is None,
            "calls": [
                {
                    "id": r.id,
                    "operator": r.operator,
                    "started_at": r.started_at,
                    "duration_s": round(r.duration_s, 1),
                    "turns": len(r.turns),
                    "summary": r.summary,
                    "action_items": r.action_items,
                }
                for r in records
            ],
        }
    )


@app.get("/api/calls/{call_id}")
async def read_call(call_id: str, request: Request) -> Response:
    if not _signed_in(request.session):
        return JSONResponse({"detail": "sign in first"}, 401)
    record = await _store(app).get(call_id)
    visible = _visible_to(request.session)
    # Same answer for "does not exist" and "not yours": a 403 on a real id
    # tells a stranger the call happened.
    if record is None or (visible is not None and record.operator != visible):
        return JSONResponse({"detail": "not found"}, 404)
    return JSONResponse(
        {
            "id": record.id,
            "operator": record.operator,
            "started_at": record.started_at,
            "duration_s": round(record.duration_s, 1),
            "summary": record.summary,
            "action_items": record.action_items,
            "stats": record.stats,
            "turns": record.turns,
        }
    )


@app.get("/auth/login")
async def sign_in(request: Request) -> Response:
    config = AuthConfig.from_env()
    if config is None:
        return RedirectResponse("/operator")
    state = new_state()
    request.session["oauth_state"] = state
    redirect_uri = _public_host(request) + CALLBACK_PATH
    return RedirectResponse(authorize_url(config, redirect_uri, state))


@app.get(CALLBACK_PATH)
async def sign_in_callback(request: Request) -> Response:
    config = AuthConfig.from_env()
    if config is None:
        return RedirectResponse("/operator")
    try:
        check_state(request.session.pop("oauth_state", None), request.query_params.get("state"))
        code = request.query_params.get("code")
        if not code:
            raise AuthError("google sent no code — sign-in was cancelled")
        async with httpx.AsyncClient() as client:
            email = await exchange_code(config, code, _public_host(request) + CALLBACK_PATH, client)
        request.session["email"] = authorise(config, email)
    except AuthError as exc:
        # The address is named on purpose: "not on the operator list" is only
        # actionable if you know which account you just used.
        log.warning("sign-in refused: %s", exc)
        return PlainTextResponse(str(exc), status_code=403)
    log.info("signed in %s", request.session["email"])
    return RedirectResponse("/operator")


@app.get("/auth/logout")
async def sign_out(request: Request) -> Response:
    request.session.clear()
    return RedirectResponse("/operator")


@app.get("/auth/me")
async def whoami(request: Request) -> Response:
    """Lets the console show who is signed in, and whether it needs to."""
    return JSONResponse(
        {
            "email": request.session.get("email"),
            "required": AuthConfig.from_env() is not None,
        }
    )


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
    if not _signed_in(request.session):
        return JSONResponse({"detail": "sign in first"}, 401)
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
    # Checked before accept: an unauthenticated socket must never reach
    # the pool, or a stranger is handed the next caller.
    if not _signed_in(ws.session):
        await ws.close(code=1008)
        return
    await ws.accept()
    pool = _pool(app)
    stream = ServerSocket(ws)
    operator = pool.register(stream, email=str(ws.session.get("email") or ""))
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
    app.state.active_calls += 1
    try:
        await _run_call(caller, operator)
    finally:
        app.state.active_calls -= 1
        # One socket per call: the console reconnects and re-registers, which
        # leaves no half-alive registration behind when a call ends badly.
        operator.released.set()
        with contextlib.suppress(Exception):
            await operator.ws.close()
        with contextlib.suppress(Exception):
            await caller.close()


async def _run_call(caller: MessageStream, operator: WaitingOperator) -> None:
    session_id = uuid.uuid4().hex
    started_at = time.time()
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
        # Persisting and summarising happen after the call, never during it.
        await _record_call(session_id, operator.email, started_at, trace)


async def _record_call(
    session_id: str, operator_email: str, started_at: float, trace: CallTrace
) -> None:
    summary = trace.summary()
    turns = summary.get("turns") or []
    if not isinstance(turns, list) or not turns:
        # A call where nobody was understood leaves no transcript worth keeping.
        return
    record = CallRecord(
        id=new_call_id(),
        session_id=session_id,
        operator=operator_email,
        started_at=started_at,
        ended_at=time.time(),
        direction="",
        counterparty="",
        turns=turns,
        stats={
            key: summary[key]
            for key in ("commit_to_first_audio_ms", "utterances", "barge_ins", "errors")
            if key in summary
        },
    )
    store = _store(app)
    try:
        await store.save(record)
    except Exception:
        log.exception("could not save call %s", session_id)
        return
    # The transcript is the deliverable; a failed summary must not lose it.
    try:
        summariser = Summariser(OpenAIConfig.from_env())
        try:
            result = await summariser.summarise(turns)
        finally:
            await summariser.close()
        await store.set_summary(record.id, result.text, result.action_items)
    except Exception:
        log.exception("could not summarise call %s", session_id)


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
