"""Google sign-in (SPEC A8).

Two things are being pinned here: that the guard actually covers the console
routes, and that it never covers Twilio's — a login prompt on the media socket
would take every call down.
"""

from typing import TYPE_CHECKING

import httpx
import pytest

from app.api.auth import (
    AuthConfig,
    AuthError,
    authorise,
    authorize_url,
    check_state,
    exchange_code,
    parse_emails,
)

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

CONFIG = AuthConfig(
    client_id="cid.apps.googleusercontent.com",
    client_secret="secret-value",
    allowed_emails=frozenset({"denis@example.com"}),
)


class TestConfig:
    def test_unset_credentials_mean_sign_in_is_not_configured(self) -> None:
        assert AuthConfig.from_env({}) is None
        assert AuthConfig.from_env({"GOOGLE_CLIENT_ID": "x"}) is None

    def test_emails_are_case_insensitive(self) -> None:
        assert parse_emails("Denis@Example.COM, other@x.io") == {
            "denis@example.com",
            "other@x.io",
        }

    def test_the_secret_never_reaches_a_string_representation(self) -> None:
        assert CONFIG.client_secret not in repr(CONFIG)
        assert CONFIG.client_secret not in str(CONFIG)


class TestAuthorizeUrl:
    def test_carries_the_state_and_asks_which_account(self) -> None:
        url = authorize_url(CONFIG, "https://voice.example.com/auth/callback", "st4te")
        assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
        assert "state=st4te" in url
        assert "response_type=code" in url
        assert "prompt=select_account" in url
        assert "redirect_uri=https%3A%2F%2Fvoice.example.com%2Fauth%2Fcallback" in url


class TestState:
    def test_matching_state_passes(self) -> None:
        check_state("abc", "abc")

    def test_missing_or_wrong_state_is_refused(self) -> None:
        for expected, received in (("abc", "xyz"), (None, "abc"), ("abc", None), (None, None)):
            with pytest.raises(AuthError):
                check_state(expected, received)


class TestAuthorise:
    def test_an_empty_allowlist_admits_nobody(self) -> None:
        empty = AuthConfig(client_id="c", client_secret="s", allowed_emails=frozenset())
        with pytest.raises(AuthError, match="not on the operator list"):
            authorise(empty, "denis@example.com")

    def test_a_listed_address_is_admitted(self) -> None:
        assert authorise(CONFIG, "denis@example.com") == "denis@example.com"

    def test_an_unlisted_address_is_refused(self) -> None:
        with pytest.raises(AuthError):
            authorise(CONFIG, "stranger@example.com")


class TestExchange:
    def transport(self, token: object, profile: object) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json=token)
            return httpx.Response(200, json=profile)

        return httpx.MockTransport(handler)

    async def test_returns_the_verified_email(self) -> None:
        transport = self.transport(
            {"access_token": "at"},
            {"email": "Denis@Example.com", "email_verified": True},
        )
        async with httpx.AsyncClient(transport=transport) as client:
            email = await exchange_code(CONFIG, "code", "https://x/auth/callback", client)
        assert email == "denis@example.com"

    async def test_an_unverified_address_is_refused(self) -> None:
        transport = self.transport(
            {"access_token": "at"},
            {"email": "denis@example.com", "email_verified": False},
        )
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(AuthError, match="unverified"):
                await exchange_code(CONFIG, "code", "https://x/auth/callback", client)

    async def test_a_refused_exchange_does_not_leak_the_secret(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "invalid_client"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(AuthError) as caught:
                await exchange_code(CONFIG, "code", "https://x/auth/callback", client)
        assert CONFIG.client_secret not in str(caught.value)


class TestGuardedRoutes:
    def client(self) -> "TestClient":
        from fastapi.testclient import TestClient

        from app.api.main import app

        return TestClient(app)

    @pytest.fixture(autouse=True)
    def _configured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GOOGLE_CLIENT_ID", CONFIG.client_id)
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", CONFIG.client_secret)
        monkeypatch.setenv("OPERATOR_EMAILS", "denis@example.com")

    def test_the_console_page_sends_you_to_sign_in(self) -> None:
        response = self.client().get("/operator", follow_redirects=False)
        assert response.status_code == 307
        assert response.headers["location"] == "/auth/login"

    def test_the_dial_endpoint_is_closed(self) -> None:
        response = self.client().post("/call", json={"to": "+12025550123"})
        assert response.status_code == 401

    def test_the_call_trace_is_closed(self) -> None:
        """It holds transcripts of real conversations."""
        assert self.client().get("/debug/last-call").status_code == 401

    def test_the_operator_socket_is_closed(self) -> None:
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with self.client().websocket_connect("/ws/operator"):
                pass

    def test_twilios_routes_stay_open(self) -> None:
        """A login prompt here takes every call down: Twilio cannot answer it."""
        response = self.client().post("/twilio/voice", data={})
        assert response.status_code == 200
        assert "<Response>" in response.text

    def test_health_stays_open_for_the_deploy_script(self) -> None:
        assert self.client().get("/health").status_code == 200


class TestUnconfigured:
    """With no Google credentials the console stays reachable, so a box that
    has not been set up yet does not lock its owner out mid-call."""

    @pytest.fixture(autouse=True)
    def _unconfigured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
        monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)

    def test_the_console_is_served(self) -> None:
        from fastapi.testclient import TestClient

        from app.api.main import app

        response = TestClient(app).get("/operator", follow_redirects=False)
        assert response.status_code == 200
