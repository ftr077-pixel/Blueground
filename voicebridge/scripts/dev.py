#!/usr/bin/env python3
"""Run the server and the tunnel together, then print the URLs to use.

One window, one Ctrl+C. Keeping the two processes together removes the
question of which window a keystroke landed in — the failure that has cost
the most time so far.

Usage:  make dev
"""

import asyncio
import contextlib
import os
import shutil
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.devserver import banner, extract_tunnel_url

ROOT = Path(__file__).resolve().parents[1]
PORT = os.environ.get("PORT", "8080")
URL_WAIT_S = 60.0


async def _print_tunnel_lines(process: asyncio.subprocess.Process) -> str | None:
    """Surface the tunnel's URL and stay quiet about the rest of its noise."""
    assert process.stdout is not None
    url: str | None = None
    while True:
        raw = await process.stdout.readline()
        if not raw:
            return url
        line = raw.decode(errors="replace").rstrip()
        found = extract_tunnel_url(line)
        if found and url is None:
            url = found
            print(banner(url), flush=True)
        elif "ERR" in line or "error" in line.lower():
            print(f"[tunnel] {line}", flush=True)


def _resolve_uv() -> str | None:
    """uv may not be on PATH yet in the shell that just ran `make setup`."""
    found = shutil.which("uv")
    if found:
        return found
    fallback = Path.home() / ".local/bin/uv"
    return str(fallback) if fallback.exists() else None


async def run(uv: str) -> int:
    server = await asyncio.create_subprocess_exec(
        uv, "run", "uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", PORT, cwd=ROOT
    )
    tunnel = await asyncio.create_subprocess_exec(
        "cloudflared",
        "tunnel",
        "--url",
        f"http://localhost:{PORT}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    reader = asyncio.create_task(_print_tunnel_lines(tunnel))

    try:
        done, _ = await asyncio.wait(
            [asyncio.create_task(server.wait()), asyncio.create_task(tunnel.wait())],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            task.result()
        print("\none of the processes exited — stopping the other", flush=True)
        return 1
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 0
    finally:
        reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reader
        for process in (server, tunnel):
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.send_signal(signal.SIGTERM)
        for process in (server, tunnel):
            with contextlib.suppress(Exception):
                await asyncio.wait_for(process.wait(), 5.0)


def main() -> int:
    if shutil.which("cloudflared") is None:
        print("cloudflared is not installed. Install it with:  brew install cloudflared")
        return 1
    uv = _resolve_uv()
    if uv is None:
        print("uv is missing — run 'make setup' first")
        return 1
    return asyncio.run(run(uv))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0) from None
