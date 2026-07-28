"""TwiML responses for the inbound-call webhook (ADR-001).

Pure string building so the exact XML Twilio receives is unit-testable.
"""

from xml.sax.saxutils import escape, quoteattr

_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'


def connect_stream(ws_url: str) -> str:
    """Hand the call's audio to our media WebSocket, both directions."""
    return f"{_HEADER}<Response><Connect><Stream url={quoteattr(ws_url)} /></Connect></Response>"


def reject(message: str) -> str:
    """Say something and hang up — used when no operator is connected."""
    return f"{_HEADER}<Response><Say>{escape(message)}</Say><Hangup /></Response>"


def media_stream_url(public_host: str, path: str = "/ws/twilio") -> str:
    """Turn the configured https host into the wss URL Twilio must dial."""
    host = public_host.rstrip("/")
    if host.startswith("https://"):
        host = "wss://" + host[len("https://") :]
    elif host.startswith("http://"):
        host = "ws://" + host[len("http://") :]
    elif not host.startswith(("ws://", "wss://")):
        host = "wss://" + host
    return host + path
