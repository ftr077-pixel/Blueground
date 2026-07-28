#!/usr/bin/env python3
"""Print which configuration values are filled in and which are not.

Never prints the values themselves — safe to share the output.

Usage:  python scripts/check_env.py [path-to-.env]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.env_check import Report, blocking, check, parse_env_file  # noqa: E402


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    env_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / ".env"
    if not env_path.exists():
        print(f"No configuration file at {env_path}")
        print(f"Copy the template first:  cp {root / '.env.example'} {env_path}")
        return 1
    results = check(parse_env_file(env_path.read_text(encoding="utf-8")))
    print(f"Checking {env_path}\n")
    print(Report(results).render())
    return 1 if blocking(results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
