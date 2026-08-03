"""Vendor latency probe (SPEC §8.4) and the connection warm-up it exists to
verify. The vendors themselves are not reachable from a test run, so what is
pinned here is the reporting and the failure behaviour."""

import httpx

from app.probe import Measurement, render
from app.providers.mt.openai_chat import OpenAIConfig, OpenAITranslator

CONFIG = OpenAIConfig(
    api_key="k", fast_model="gpt-4o-mini", quality_model="gpt-4o", base_url="https://x"
)


class TestMeasurement:
    def test_percentiles_over_a_known_set(self) -> None:
        m = Measurement("s")
        for value in (100.0, 200.0, 300.0, 400.0, 500.0):
            m.add(value)
        assert m.p50 == 300.0
        assert m.p95 == 500.0
        assert m.worst == 500.0

    def test_no_samples_reports_nothing_rather_than_zero(self) -> None:
        m = Measurement("s")
        assert (m.p50, m.p95, m.worst) == (None, None, None)


class TestRender:
    def test_a_failing_vendor_is_named_not_hidden(self) -> None:
        out = render([Measurement("MT warm (gpt-4o-mini)", error="AuthError: 401")])
        assert "AuthError: 401" in out

    def test_the_verdict_compares_against_the_spec_budget(self) -> None:
        warm = Measurement("MT warm (gpt-4o-mini)", samples=[600.0])
        tts = Measurement("TTS first chunk", samples=[240.0])
        assert "within" in render([warm, tts], budget_ms=1500.0)
        assert "OVER" in render([warm, tts], budget_ms=500.0)

    def test_no_verdict_without_measurements(self) -> None:
        out = render([Measurement("MT warm (gpt-4o-mini)", error="down")])
        assert "budget" not in out


class TestWarm:
    async def test_warm_opens_the_connection(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await OpenAITranslator(CONFIG, client).warm()
        assert seen == ["/v1/models"]

    async def test_a_failed_warm_up_is_not_an_error(self) -> None:
        """It is an optimisation; the real request reports its own failure."""

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await OpenAITranslator(CONFIG, client).warm()
