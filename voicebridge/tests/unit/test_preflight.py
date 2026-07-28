"""Preflight tests: report shape, optional-vendor skipping, and the promise
that a failing vendor is named rather than crashing the check."""

from app.preflight import Check, check_deepgram, render


class TestRender:
    def test_all_ok_says_ready(self) -> None:
        checks = [Check("A", True, "fine"), Check("B", True, "fine")]
        assert render(checks).endswith("All vendors answered. The pipeline can run a call.")

    def test_failures_are_named(self) -> None:
        checks = [Check("Speechmatics (he)", False, "AuthError: 401"), Check("B", True, "ok")]
        out = render(checks)
        assert "FAIL" in out
        assert "Not ready: Speechmatics (he)" in out

    def test_detail_is_shown_for_diagnosis(self) -> None:
        assert "401" in render([Check("X", False, "AuthError: 401")])


class TestOptionalVendors:
    async def test_deepgram_is_skipped_without_a_key(self) -> None:
        assert await check_deepgram({}) is None

    async def test_deepgram_failure_is_reported_not_raised(self) -> None:
        result = await check_deepgram(
            {"DEEPGRAM_API_KEY": "bad", "DEEPGRAM_ENDPOINT": "wss://127.0.0.1:1/listen"}
        )
        assert result is not None
        assert result.ok is False
        assert result.vendor == "Deepgram (en)"


class TestHttpDetail:
    def test_insufficient_quota_is_explained_not_just_numbered(self) -> None:
        import httpx

        from app.preflight import _http_detail

        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(
            429,
            json={"error": {"code": "insufficient_quota", "message": "quota"}},
            request=request,
        )
        exc = httpx.HTTPStatusError("429", request=request, response=response)
        detail = _http_detail(exc)
        assert "insufficient_quota" in detail
        assert "no credit balance" in detail

    def test_real_rate_limit_is_not_mislabelled_as_billing(self) -> None:
        import httpx

        from app.preflight import _http_detail

        request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
        response = httpx.Response(
            429,
            json={"error": {"code": "rate_limit_exceeded", "message": "slow down"}},
            request=request,
        )
        exc = httpx.HTTPStatusError("429", request=request, response=response)
        detail = _http_detail(exc)
        assert "rate_limit_exceeded" in detail
        assert "no credit balance" not in detail

    def test_non_http_errors_still_report_their_type(self) -> None:
        from app.preflight import _http_detail

        assert "ConnectionError" in _http_detail(ConnectionError("refused"))
