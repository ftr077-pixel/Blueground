#!/usr/bin/env python3
"""Check every configured vendor answers, without placing a call.

Usage:  make preflight
Output is safe to share: no keys, no audio.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.env_check import load_env_file
from app.preflight import render, run_all

ROOT = Path(__file__).resolve().parents[1]


async def contact_vendors() -> int:
    print("Contacting vendors (up to 20s each)...\n")
    checks = await run_all()
    print(render(checks))
    return 1 if any(not check.ok for check in checks) else 0


def main() -> int:
    load_env_file(ROOT / ".env")
    return asyncio.run(contact_vendors())


if __name__ == "__main__":
    raise SystemExit(main())
