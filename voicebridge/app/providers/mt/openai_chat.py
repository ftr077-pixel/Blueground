"""Translator over an OpenAI-compatible chat-completions endpoint (ADR-003).

Fast tier and quality tier are the same wire protocol with a different model
name, so one client serves both. Written against the HTTP API rather than the
vendor SDK, which keeps the dependency at httpx and lets the same client point
at any OpenAI-compatible endpoint if the host ever changes.

Configuration comes from the environment — no URLs or keys in code.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass

import httpx

from app.providers.base import Glossary, Tier, Translation, Translator, Turn
from app.providers.mt.prompts import build_fast_prompt

DEFAULT_BASE_URL = "https://api.openai.com"
_TIMEOUT_S = 10.0


@dataclass(frozen=True, slots=True)
class OpenAIConfig:
    api_key: str
    fast_model: str
    quality_model: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "OpenAIConfig":
        e = os.environ if env is None else env
        api_key = e.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY must be set")
        fast_model = e.get("MT_MODEL_FAST", "gpt-4o-mini")
        return cls(
            api_key=api_key,
            fast_model=fast_model,
            quality_model=e.get("MT_MODEL_QUALITY", fast_model),
            base_url=e.get("MT_BASE_URL", DEFAULT_BASE_URL).rstrip("/"),
        )


class OpenAITranslator(Translator):
    def __init__(self, config: OpenAIConfig, client: httpx.AsyncClient | None = None) -> None:
        self._config = config
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(_TIMEOUT_S),
            headers={"Authorization": f"Bearer {config.api_key}"},
        )

    async def translate(
        self,
        text: str,
        source: str,
        target: str,
        context: list[Turn],
        glossary: Glossary | None,
        tier: Tier,
    ) -> Translation:
        prompt = build_fast_prompt(text, source, target, context, glossary)
        model = self._config.fast_model if tier == "fast" else self._config.quality_model
        response = await self._client.post(
            f"{self._config.base_url}/v1/chat/completions",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": prompt.system},
                    {"role": "user", "content": prompt.user},
                ],
                "temperature": 0.2,
                # A translation is roughly input-sized; the cap guards the
                # latency budget against a model that starts rambling.
                "max_tokens": max(64, 2 * len(text.split()) * 4),
            },
        )
        response.raise_for_status()
        body = response.json()
        translated = str(body["choices"][0]["message"]["content"]).strip()
        return Translation(text=translated, tier=tier)

    async def close(self) -> None:
        await self._client.aclose()
