"""Helpers for the single-command development runner.

The quick tunnel hands out a new hostname every restart, and that hostname
has to be pasted into three places. Getting it wrong loses a call and the
reason is never obvious, so the runner extracts it and prints every URL
ready to use.
"""

import re

TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def extract_tunnel_url(line: str) -> str | None:
    match = TUNNEL_URL.search(line)
    return match.group(0) if match else None


def banner(url: str) -> str:
    rule = "─" * 68
    return "\n".join(
        [
            "",
            rule,
            "  READY — the address changes every restart, so update Twilio now",
            rule,
            "",
            "  1. Twilio -> Phone Numbers -> your number -> Voice Configuration",
            "     'A call comes in' = Webhook, HTTP POST, this URL:",
            f"       {url}/twilio/voice",
            "",
            "  2. Open the console and press Connect:",
            f"       {url}/operator",
            "",
            "  3. After the call, the per-stage timings are here:",
            f"       {url}/debug/last-call",
            "",
            rule,
            "",
        ]
    )
