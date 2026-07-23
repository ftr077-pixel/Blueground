"""Перевод через локальный vLLM (OpenAI-compatible API).

Держим скользящее окно последних реплик диалога — LLM переводит
контекстно (местоимения, обрывки фраз, разговорный иврит).
"""
from __future__ import annotations

import os
from collections import deque

from openai import AsyncOpenAI

_LANG = {"he": "Hebrew", "en": "English"}


class QwenTranslator:
    def __init__(self, system_prompt: str, temperature: float = 0.2,
                 max_tokens: int = 512, history_turns: int = 6):
        self.client = AsyncOpenAI(
            base_url=os.environ.get("VLLM_BASE_URL", "http://127.0.0.1:8000/v1"),
            api_key="local",
        )
        self.model = os.environ.get("VLLM_MODEL", "Qwen/Qwen3-8B-AWQ")
        self.system_prompt = system_prompt
        self.temperature = temperature
        self.max_tokens = max_tokens
        # общая история звонка: [("he", "текст"), ("en", "text"), ...]
        self.history: deque[tuple[str, str]] = deque(maxlen=history_turns)

    async def translate(self, text: str, src: str, dst: str) -> str:
        if not text:
            return ""
        sys = self.system_prompt.format(src=_LANG[src], dst=_LANG[dst])
        messages = [{"role": "system", "content": sys}]
        # контекст предыдущих реплик — как перемежающийся диалог
        for lang, t in self.history:
            role = "user" if lang == src else "assistant"
            messages.append({"role": role, "content": t})
        messages.append({"role": "user", "content": text})

        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},  # Qwen3: без reasoning
        )
        out = (resp.choices[0].message.content or "").strip()
        self.history.append((src, text))
        return out
