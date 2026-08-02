"""Twilio outbound dialling (ADR-001, SPEC A7).

Placing a call is one REST request; the interesting part is what it points at.
We send the TwiML inline rather than a callback URL so the dialled call joins
the same ``<Connect><Stream>`` path an inbound call takes — one media path,
one set of bugs.

Twilio explains its refusals in the response body (an unverified number on a
trial account, a caller ID that is not yours), and those are exactly the ones
an operator can act on, so the body is read rather than the status code alone.
"""

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass

import httpx

from app.telephony.twiml import connect_stream

DEFAULT_API_BASE = "https://api.twilio.com"
TIMEOUT_S = 15.0


@dataclass(frozen=True, slots=True)
class TwilioRestConfig:
    account_sid: str
    auth_token: str
    from_number: str
    api_base: str = DEFAULT_API_BASE

    def __repr__(self) -> str:
        # Config objects end up in tracebacks and log lines; the auth token
        # must not ride along.
        return f"TwilioRestConfig(account_sid={self.account_sid!r}, from={self.from_number!r})"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "TwilioRestConfig":
        e = os.environ if env is None else env
        names = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER")
        missing = [name for name in names if not e.get(name)]
        if missing:
            raise RuntimeError(f"{', '.join(missing)} must be set to place a call")
        return cls(
            account_sid=e["TWILIO_ACCOUNT_SID"],
            auth_token=e["TWILIO_AUTH_TOKEN"],
            from_number=e["TWILIO_PHONE_NUMBER"],
            api_base=e.get("TWILIO_API_BASE", DEFAULT_API_BASE),
        )


class TwilioDialer:
    """OutboundDialer over the Twilio REST API (SPEC §6.1)."""

    def __init__(self, config: TwilioRestConfig, client: httpx.AsyncClient) -> None:
        self._config = config
        self._client = client

    async def dial(self, to: str, stream_url: str) -> str:
        config = self._config
        response = await self._client.post(
            f"{config.api_base}/2010-04-01/Accounts/{config.account_sid}/Calls.json",
            auth=(config.account_sid, config.auth_token),
            data={
                "To": to,
                "From": config.from_number,
                "Twiml": connect_stream(stream_url),
            },
            timeout=TIMEOUT_S,
        )
        if response.status_code >= 400:
            raise RuntimeError(_refusal(response))
        sid = response.json().get("sid")
        if not sid:
            raise RuntimeError("twilio accepted the call but returned no sid")
        return str(sid)


def _refusal(response: httpx.Response) -> str:
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError):
        return f"twilio refused the call: HTTP {response.status_code}"
    message = body.get("message") if isinstance(body, dict) else None
    code = body.get("code") if isinstance(body, dict) else None
    if not message:
        return f"twilio refused the call: HTTP {response.status_code}"
    return f"twilio refused the call ({code}): {message}"
