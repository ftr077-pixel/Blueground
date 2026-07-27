"""OpenAITranslator tests over httpx.MockTransport — request shape, tier
routing, glossary/context injection, and failure propagation, all offline."""

import json

import httpx
import pytest

from app.providers.base import Glossary, GlossaryEntry, Turn
from app.providers.mt.openai_chat import OpenAIConfig, OpenAITranslator

CONFIG = OpenAIConfig(
    api_key="test-key",
    fast_model="fast-model",
    quality_model="quality-model",
    base_url="https://api.example.test",
)


def make_translator(
    handler: "httpx.MockTransport | None" = None,
    reply: str = "Hello",
    config: OpenAIConfig = CONFIG,
) -> tuple[OpenAITranslator, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def default_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": f" {reply} \n"}}]})

    transport = handler or httpx.MockTransport(default_handler)
    client = httpx.AsyncClient(transport=transport)
    return OpenAITranslator(config, client=client), seen


async def test_fast_tier_posts_openai_shape_and_strips_reply() -> None:
    translator, seen = make_translator(reply="Hello friend")
    result = await translator.translate("שלום חבר", "he", "en", [], None, "fast")
    assert result.text == "Hello friend"
    assert result.tier == "fast"
    request = seen[0]
    assert request.url.path == "/v1/chat/completions"
    body = json.loads(request.content)
    assert body["model"] == "fast-model"
    assert body["messages"][1] == {"role": "user", "content": "שלום חבר"}
    assert "Hebrew" in body["messages"][0]["content"]


async def test_quality_tier_routes_to_quality_model() -> None:
    translator, seen = make_translator()
    await translator.translate("שלום", "he", "en", [], None, "quality")
    assert json.loads(seen[0].content)["model"] == "quality-model"


async def test_glossary_and_context_reach_the_prompt() -> None:
    translator, seen = make_translator()
    glossary = Glossary(entries=(GlossaryEntry(source="Blueground", target=None),))
    context = [
        Turn(
            direction="a2b",
            source_lang="he",
            target_lang="en",
            source_text="שלום",
            translated_text="Hello",
        )
    ]
    await translator.translate("מה שלומך", "he", "en", context, glossary, "fast")
    system = json.loads(seen[0].content)["messages"][0]["content"]
    assert "Blueground" in system
    assert "Hello" in system


async def test_server_error_raises_for_orchestrator_error_path() -> None:
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="vllm down")

    translator, _ = make_translator(handler=httpx.MockTransport(failing))
    with pytest.raises(httpx.HTTPStatusError):
        await translator.translate("שלום", "he", "en", [], None, "fast")


def test_config_from_env_requires_a_key_and_defaults_the_rest() -> None:
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        OpenAIConfig.from_env({})
    config = OpenAIConfig.from_env({"OPENAI_API_KEY": "k", "MT_MODEL_FAST": "m1"})
    assert config.base_url == "https://api.openai.com"
    assert config.quality_model == "m1"
