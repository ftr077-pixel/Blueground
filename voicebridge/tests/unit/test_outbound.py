"""Outbound dialling: the number policy (SPEC A7) and the Twilio REST call.

The policy tests matter more than they look: the endpoint sits on a public
tunnel with no auth until M2, so every hole here is billable.
"""

from typing import TYPE_CHECKING

import httpx
import pytest

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

from app.api.outbound import allowlist, normalise
from app.telephony.twilio_rest import TwilioDialer, TwilioRestConfig

CONFIG = TwilioRestConfig(
    account_sid="AC" + "0" * 32,
    auth_token="f" * 32,
    from_number="+12025550123",
)


class TestNormalise:
    def test_accepts_e164(self) -> None:
        assert normalise("+972501234567") == "+972501234567"

    def test_strips_what_humans_type(self) -> None:
        assert normalise("  +972 (50) 123-45.67 ") == "+972501234567"

    def test_accepts_the_00_international_prefix(self) -> None:
        assert normalise("00972501234567") == "+972501234567"

    def test_rejects_anything_not_a_number(self) -> None:
        for bad in ("", "972501234567", "+0501234567", "+9725", "+" + "9" * 20, "sip:x@y"):
            assert normalise(bad) is None, bad


class TestAllowlist:
    def test_unset_means_outbound_is_off_not_unrestricted(self) -> None:
        assert allowlist({}) == frozenset()
        assert allowlist({"OUTBOUND_ALLOWED": ""}) == frozenset()

    def test_entries_are_normalised_so_formatting_cannot_bypass_it(self) -> None:
        allowed = allowlist({"OUTBOUND_ALLOWED": "+972 50 123 4567, 00972501234568"})
        assert allowed == {"+972501234567", "+972501234568"}

    def test_malformed_entries_are_dropped_not_trusted(self) -> None:
        assert allowlist({"OUTBOUND_ALLOWED": "garbage,+12025550123"}) == {"+12025550123"}


class TestTwilioDialer:
    async def test_dial_posts_the_stream_twiml_and_returns_the_call_id(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization", "")
            seen["body"] = request.content.decode()
            return httpx.Response(201, json={"sid": "CA123"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        dialer = TwilioDialer(CONFIG, client)
        sid = await dialer.dial("+972501234567", "wss://host.example.com/ws/twilio")
        await client.aclose()

        assert sid == "CA123"
        assert str(seen["url"]).endswith(f"/Accounts/{CONFIG.account_sid}/Calls.json")
        assert str(seen["auth"]).startswith("Basic ")
        body = str(seen["body"])
        assert "To=%2B972501234567" in body
        assert "From=%2B12025550123" in body
        # The dialled call must join the same media path as an inbound one.
        assert "Stream" in body and "ws%2Ftwilio" in body

    async def test_a_vendor_refusal_names_twilios_own_reason(self) -> None:
        """Twilio's failures are the ones an operator can act on — an
        unverified number on a trial account, a wrong caller ID — and they
        arrive as JSON, not as a status code."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={"code": 21219, "message": "To number is not verified"},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        dialer = TwilioDialer(CONFIG, client)
        with pytest.raises(RuntimeError, match="not verified"):
            await dialer.dial("+972501234567", "wss://host/ws/twilio")
        await client.aclose()

    async def test_a_body_that_is_not_json_still_reports_something_usable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(502, text="<html>bad gateway</html>")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        dialer = TwilioDialer(CONFIG, client)
        with pytest.raises(RuntimeError, match="502"):
            await dialer.dial("+972501234567", "wss://host/ws/twilio")
        await client.aclose()

    def test_config_from_env_requires_every_value(self) -> None:
        with pytest.raises(RuntimeError, match="TWILIO_"):
            TwilioRestConfig.from_env({})
        config = TwilioRestConfig.from_env(
            {
                "TWILIO_ACCOUNT_SID": CONFIG.account_sid,
                "TWILIO_AUTH_TOKEN": CONFIG.auth_token,
                "TWILIO_PHONE_NUMBER": CONFIG.from_number,
            }
        )
        assert config.from_number == CONFIG.from_number

    def test_credentials_never_reach_a_string_representation(self) -> None:
        """This object gets logged by accident sooner or later."""
        assert CONFIG.auth_token not in repr(CONFIG)
        assert CONFIG.auth_token not in str(CONFIG)


class TestCallEndpoint:
    """Guards on /call. Each one of these is a bill if it stops holding."""

    def client(self) -> "TestClient":
        from fastapi.testclient import TestClient

        from app.api.main import app

        return TestClient(app)

    def test_a_number_that_is_not_a_number_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OUTBOUND_ALLOWED", "+12025550123")
        response = self.client().post("/call", json={"to": "nonsense"})
        assert response.status_code == 400

    def test_outbound_is_off_until_the_allowlist_is_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OUTBOUND_ALLOWED", raising=False)
        response = self.client().post("/call", json={"to": "+12025550123"})
        assert response.status_code == 403
        assert "OUTBOUND_ALLOWED" in response.json()["detail"]

    def test_a_number_outside_the_allowlist_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OUTBOUND_ALLOWED", "+12025550123")
        response = self.client().post("/call", json={"to": "+972501234567"})
        assert response.status_code == 403

    def test_dialling_with_nobody_listening_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise the dialled party hears silence and hangs up."""
        monkeypatch.setenv("OUTBOUND_ALLOWED", "+12025550123")
        response = self.client().post("/call", json={"to": "+12025550123"})
        assert response.status_code == 409
