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
