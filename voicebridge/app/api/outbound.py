"""Who the console is allowed to ring (SPEC A7).

The control plane has no auth until M2 and it is reachable on a public tunnel,
so an open dial endpoint is somebody else's phone bill. Until auth exists the
rule is fail-closed: an unset allowlist means outbound calling is off, not
unrestricted.
"""

import os
import re
from collections.abc import Mapping

E164 = re.compile(r"^\+[1-9]\d{6,14}$")


def normalise(number: str) -> str | None:
    """Return the E.164 form of a dialled number, or None if it is not one.

    Spaces, dashes and brackets are what a human types; anything left over
    after removing them is a number we refuse rather than guess at.
    """
    compact = re.sub(r"[\s\-().]", "", number.strip())
    if compact.startswith("00"):
        compact = "+" + compact[2:]
    return compact if E164.match(compact) else None


def allowlist(env: Mapping[str, str] | None = None) -> frozenset[str]:
    e = os.environ if env is None else env
    entries = (normalise(part) for part in e.get("OUTBOUND_ALLOWED", "").split(","))
    return frozenset(entry for entry in entries if entry is not None)
