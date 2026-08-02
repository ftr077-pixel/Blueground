"""Google sign-in for the operator console (SPEC A8).

Only the control plane is protected. ADR-001 puts Twilio on `/twilio/voice`
and `/ws/twilio`, and Twilio cannot answer a login prompt, so those routes
stay open by design — see the amendment for what that leaves outstanding.

The flow is the plain OAuth 2.0 authorization code exchange against Google,
then one call to the OpenID userinfo endpoint. No token is stored and no JWT
is parsed: the only thing we keep is the verified email address, in a signed
session cookie.
"""

import os
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CALLBACK_PATH = "/auth/callback"
TIMEOUT_S = 15.0


class AuthError(Exception):
    """Sign-in was refused. The message is shown to the person signing in."""


@dataclass(frozen=True, slots=True)
class AuthConfig:
    client_id: str
    client_secret: str
    allowed_emails: frozenset[str]

    def __repr__(self) -> str:
        return f"AuthConfig(client_id={self.client_id!r}, allowed={len(self.allowed_emails)})"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "AuthConfig | None":
        """None means sign-in is not configured on this deployment."""
        e = os.environ if env is None else env
        client_id = e.get("GOOGLE_CLIENT_ID", "").strip()
        client_secret = e.get("GOOGLE_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            return None
        return cls(
            client_id=client_id,
            client_secret=client_secret,
            allowed_emails=parse_emails(e.get("OPERATOR_EMAILS", "")),
        )


def parse_emails(raw: str) -> frozenset[str]:
    return frozenset(part.strip().casefold() for part in raw.split(",") if part.strip())


def authorize_url(config: AuthConfig, redirect_uri: str, state: str) -> str:
    query = urlencode(
        {
            "client_id": config.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email",
            "state": state,
            # Without this Google silently re-uses the last account on a
            # shared machine, which is the wrong default for a console that
            # records who handled a call.
            "prompt": "select_account",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def new_state() -> str:
    return secrets.token_urlsafe(24)


def check_state(expected: str | None, received: str | None) -> None:
    # Without this an attacker can hand someone a callback URL and log them
    # into an account that is not theirs.
    if not expected or not received or not secrets.compare_digest(expected, received):
        raise AuthError("sign-in expired or was tampered with — try again")


async def exchange_code(
    config: AuthConfig, code: str, redirect_uri: str, client: httpx.AsyncClient
) -> str:
    """Trade the callback code for the signed-in email address."""
    token_response = await client.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=TIMEOUT_S,
    )
    if token_response.status_code >= 400:
        raise AuthError("google refused the sign-in")
    access_token = token_response.json().get("access_token")
    if not access_token:
        raise AuthError("google returned no access token")

    userinfo = await client.get(
        USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=TIMEOUT_S,
    )
    if userinfo.status_code >= 400:
        raise AuthError("could not read the google profile")
    profile = userinfo.json()
    email = str(profile.get("email", "")).casefold()
    if not email:
        raise AuthError("google returned no email address")
    # An unverified address can be anything the account holder typed.
    if profile.get("email_verified") is False:
        raise AuthError("this google account has an unverified email address")
    return email


def authorise(config: AuthConfig, email: str) -> str:
    """Fail closed: an empty allowlist admits nobody, not everybody."""
    if email not in config.allowed_emails:
        raise AuthError(f"{email} is not on the operator list")
    return email
