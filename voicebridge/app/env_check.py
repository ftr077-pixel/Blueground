"""Operator-facing configuration check.

Run before the first call to find a missing or malformed value in seconds
instead of during a live call. Values are never printed or logged — only the
variable name and a verdict, because this output gets pasted into chats.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum


class Status(StrEnum):
    OK = "ok"
    MISSING = "missing"
    MALFORMED = "malformed"


@dataclass(frozen=True, slots=True)
class Rule:
    name: str
    where: str
    pattern: str | None = None
    expected: str = ""
    required_for_first_call: bool = True


@dataclass(frozen=True, slots=True)
class Result:
    name: str
    status: Status
    where: str
    expected: str
    required: bool


RULES: tuple[Rule, ...] = (
    Rule(
        name="TWILIO_ACCOUNT_SID",
        where="Twilio console home, Account Info",
        pattern=r"^AC[0-9a-fA-F]{32}$",
        expected="starts with AC, 34 characters total",
    ),
    Rule(
        name="TWILIO_AUTH_TOKEN",
        where="Twilio console home, Account Info, behind 'Show'",
        pattern=r"^[0-9a-fA-F]{32}$",
        expected="32 hex characters",
    ),
    Rule(
        name="TWILIO_PHONE_NUMBER",
        where="Twilio, Phone Numbers -> Active numbers",
        pattern=r"^\+[1-9]\d{6,14}$",
        expected="international format, e.g. +12025550123",
    ),
    Rule(
        name="SPEECHMATICS_API_KEY",
        where="portal.speechmatics.com -> API keys",
        expected="any non-empty key",
    ),
    Rule(
        name="OPENAI_API_KEY",
        where="platform.openai.com/api-keys",
        pattern=r"^sk-\S+$",
        expected="starts with sk-",
    ),
    Rule(
        name="CARTESIA_API_KEY",
        where="play.cartesia.ai -> API keys",
        expected="any non-empty key",
    ),
    Rule(
        name="CARTESIA_VOICE_HE",
        where="Cartesia voice library, the UUID under a Hebrew voice",
        expected="any non-empty voice id",
    ),
    Rule(
        name="CARTESIA_VOICE_EN",
        where="Cartesia voice library, the UUID under an English voice",
        expected="any non-empty voice id",
    ),
    Rule(
        name="DEEPGRAM_API_KEY",
        where="console.deepgram.com -> API keys",
        expected="any non-empty key",
        required_for_first_call=False,
    ),
    Rule(
        name="PUBLIC_HOST",
        where="printed by the tunnel once the server runs",
        pattern=r"^https://\S+[^/]$",
        expected="https:// address with no trailing slash",
        required_for_first_call=False,
    ),
)

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$")


def parse_env_file(text: str) -> dict[str, str]:
    """Parse KEY=VALUE lines, ignoring comments, blanks and inline quotes."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _LINE.match(line)
        if match is None:
            continue
        key, raw = match.group(1), match.group(2)
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        values[key] = raw
    return values


def check(values: Mapping[str, str], rules: Iterable[Rule] = RULES) -> list[Result]:
    results: list[Result] = []
    for rule in rules:
        raw = values.get(rule.name, "").strip()
        if not raw:
            status = Status.MISSING
        elif rule.pattern is not None and re.match(rule.pattern, raw) is None:
            status = Status.MALFORMED
        else:
            status = Status.OK
        results.append(
            Result(
                name=rule.name,
                status=status,
                where=rule.where,
                expected=rule.expected,
                required=rule.required_for_first_call,
            )
        )
    return results


def blocking(results: Iterable[Result]) -> list[Result]:
    """Problems that stop the first call from happening at all."""
    return [r for r in results if r.required and r.status is not Status.OK]


@dataclass(slots=True)
class Report:
    results: list[Result] = field(default_factory=list)

    def render(self) -> str:
        lines: list[str] = []
        for result in self.results:
            if result.status is Status.OK:
                lines.append(f"  ok       {result.name}")
            elif result.status is Status.MISSING:
                mark = "MISSING " if result.required else "optional"
                lines.append(f"  {mark} {result.name}  <- {result.where}")
            else:
                lines.append(f"  BAD      {result.name}  <- expected {result.expected}")
        problems = blocking(self.results)
        lines.append("")
        if problems:
            names = ", ".join(r.name for r in problems)
            lines.append(f"Not ready: fill in {names}")
        else:
            lines.append("Ready for the first call.")
        return "\n".join(lines)
