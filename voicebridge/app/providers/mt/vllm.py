"""Translator over an OpenAI-compatible chat-completions endpoint (ADR-003
amendment A2: vLLM on our GPU host serves both tiers).

The same client works against any OpenAI-compatible server, which is exactly
why it needs no vendor SDK. Configuration comes from the environment — no
URLs or keys in code.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass

import httpx

from app.providers.base import Glossary, Tier, Translation, Translator, Turn
from app.providers.mt.prompts import build_fast_prompt

_TIMEOUT_S = 10.0


@dataclass(frozen=True, slots=True)
class VllmConfig:
    base_url: str
    fast_model: str
    quality_model: str
    api_key: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "VllmConfig":
        e = os.environ if env is None else env
        base_url = e.get("VLLM_BASE_URL")
        fast_model = e.get("VLLM_MODEL_FAST")
        if not base_url or not fast_model:
            raise RuntimeError("VLLM_BASE_URL and VLLM_MODEL_FAST must be set")
        return cls(
            base_url=base_url.rstrip("/"),
            fast_model=fast_model,
            quality_model=e.get("VLLM_MODEL_QUALITY", fast_model),
            api_key=e.get("VLLM_API_KEY"),
        )


class VllmTranslator(Translator):
    def __init__(self, config: VllmConfig, client: httpx.AsyncClient | None = None) -> None:
        self._config = config
        headers = {}
        if config.api_key:
            headers["Authorization"] = f"Bearer {config.api_key}"
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(_TIMEOUT_S), headers=headers
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
