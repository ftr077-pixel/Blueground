"""Post-call summary and action items (SPEC A9).

Runs after the call has ended, on the quality tier ADR-003 reserves for
work that is allowed to be slow. Nothing here touches the media path.

The prompt asks for the operator's own language, because the summary exists
to be read by the person who handled the call and by whoever picks it up
next — not to be a second translation.
"""

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.providers.mt.openai_chat import OpenAIConfig

TIMEOUT_S = 60.0
MAX_TURNS = 400

INSTRUCTION = """You are summarising a phone call that was translated live between two \
languages. The transcript below alternates between the caller and the operator; each line \
shows what was said and its translation.

Write for the operator who handled this call and for whoever picks the matter up next.

Return JSON with exactly these keys:
  "summary": 2-4 sentences. What the caller wanted, what was established, how it ended.
  "action_items": a list of short strings, each one a concrete thing somebody must do next.

Rules:
- Only state what the transcript supports. If the call decided nothing, say so and return an
  empty action_items list. Do not invent follow-ups to look useful.
- The transcript comes from live speech recognition and contains errors. Where a line is
  garbled, work from context rather than quoting it as fact.
- Write in English."""


@dataclass(frozen=True, slots=True)
class Summary:
    text: str
    action_items: list[str] = field(default_factory=list)


def transcript_lines(turns: list[dict[str, Any]]) -> list[str]:
    """One readable line per utterance, oldest first."""
    lines: list[str] = []
    for turn in turns[:MAX_TURNS]:
        who = "Caller" if turn.get("direction") == "a2b" else "Operator"
        source = str(turn.get("source") or "").strip()
        translated = str(turn.get("translated") or "").strip()
        if not source and not translated:
            continue
        lines.append(f"{who}: {source}" + (f"  [{translated}]" if translated else ""))
    return lines


class Summariser:
    def __init__(self, config: OpenAIConfig, client: httpx.AsyncClient | None = None) -> None:
        self._config = config
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(TIMEOUT_S),
            headers={"Authorization": f"Bearer {config.api_key}"},
        )

    async def summarise(self, turns: list[dict[str, Any]]) -> Summary:
        lines = transcript_lines(turns)
        if not lines:
            return Summary(text="No speech was transcribed on this call.", action_items=[])
        response = await self._client.post(
            f"{self._config.base_url}/v1/chat/completions",
            json={
                "model": self._config.quality_model,
                "messages": [
                    {"role": "system", "content": INSTRUCTION},
                    {"role": "user", "content": "\n".join(lines)},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
            },
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return parse(content)

    async def close(self) -> None:
        await self._client.aclose()


def parse(content: str) -> Summary:
    """A model that returns something unexpected must not lose the call.

    The transcript is already stored; a summary is the disposable part.
    """
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return Summary(text=content.strip()[:2000], action_items=[])
    if not isinstance(payload, dict):
        return Summary(text=str(payload)[:2000], action_items=[])
    raw_items = payload.get("action_items")
    items = (
        [str(item).strip() for item in raw_items if str(item).strip()]
        if (isinstance(raw_items, list))
        else []
    )
    return Summary(text=str(payload.get("summary", "")).strip(), action_items=items)
