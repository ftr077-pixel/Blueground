"""Config-check tests, including the one that matters most: the report must
never leak a secret, because its output gets pasted into chats."""

from app.env_check import RULES, Report, Status, blocking, check, parse_env_file

FILLED = {
    "TWILIO_ACCOUNT_SID": "AC" + "0" * 32,
    "TWILIO_AUTH_TOKEN": "a" * 32,
    "TWILIO_PHONE_NUMBER": "+12025550123",
    "SPEECHMATICS_API_KEY": "sm-key",
    "OPENAI_API_KEY": "sk-abc123",
    "CARTESIA_API_KEY": "ct-key",
    "CARTESIA_VOICE_HE": "voice-he",
    "CARTESIA_VOICE_EN": "voice-en",
}


class TestParse:
    def test_ignores_comments_and_blanks(self) -> None:
        text = "# comment\n\nA=1\n  # another\nB = two \n"
        assert parse_env_file(text) == {"A": "1", "B": "two"}

    def test_strips_quotes_and_export(self) -> None:
        text = "export KEY=\"value\"\nOTHER='v2'\n"
        assert parse_env_file(text) == {"KEY": "value", "OTHER": "v2"}

    def test_empty_value_is_kept_as_empty(self) -> None:
        assert parse_env_file("EMPTY=\n") == {"EMPTY": ""}

    def test_value_containing_equals_survives(self) -> None:
        assert parse_env_file("K=a=b=c\n") == {"K": "a=b=c"}


class TestCheck:
    def test_fully_filled_config_is_ready(self) -> None:
        results = check(FILLED)
        assert blocking(results) == []
        assert Report(results).render().endswith("Ready for the first call.")

    def test_missing_required_value_blocks(self) -> None:
        values = dict(FILLED)
        del values["OPENAI_API_KEY"]
        problems = blocking(check(values))
        assert [r.name for r in problems] == ["OPENAI_API_KEY"]
        assert problems[0].status is Status.MISSING

    def test_whitespace_only_counts_as_missing(self) -> None:
        values = dict(FILLED) | {"CARTESIA_API_KEY": "   "}
        assert [r.name for r in blocking(check(values))] == ["CARTESIA_API_KEY"]

    def test_malformed_values_are_named_as_bad(self) -> None:
        values = dict(FILLED) | {
            "TWILIO_ACCOUNT_SID": "not-a-sid",
            "TWILIO_PHONE_NUMBER": "0501234567",
            "OPENAI_API_KEY": "abc",
        }
        problems = blocking(check(values))
        assert {r.name for r in problems} == {
            "TWILIO_ACCOUNT_SID",
            "TWILIO_PHONE_NUMBER",
            "OPENAI_API_KEY",
        }
        assert all(r.status is Status.MALFORMED for r in problems)

    def test_optional_values_do_not_block(self) -> None:
        results = check(FILLED)
        optional = [r for r in results if not r.required]
        assert {r.name for r in optional} == {"DEEPGRAM_API_KEY", "PUBLIC_HOST"}
        assert blocking(results) == []

    def test_public_host_rejects_trailing_slash(self) -> None:
        results = check(FILLED | {"PUBLIC_HOST": "https://x.example.com/"})
        host = next(r for r in results if r.name == "PUBLIC_HOST")
        assert host.status is Status.MALFORMED

    def test_example_file_shape_matches_the_rules(self) -> None:
        from pathlib import Path

        example = Path(__file__).resolve().parents[2] / ".env.example"
        keys = parse_env_file(example.read_text(encoding="utf-8"))
        for rule in RULES:
            assert rule.name in keys, f"{rule.name} missing from .env.example"


class TestNoSecretLeak:
    def test_report_never_contains_any_value(self) -> None:
        secrets = {
            "TWILIO_ACCOUNT_SID": "AC" + "f" * 32,
            "TWILIO_AUTH_TOKEN": "b" * 32,
            "TWILIO_PHONE_NUMBER": "+972501112233",
            "SPEECHMATICS_API_KEY": "sm-supersecret",
            "OPENAI_API_KEY": "sk-supersecret",
            "CARTESIA_API_KEY": "ct-supersecret",
            "CARTESIA_VOICE_HE": "he-voice-secret",
            "CARTESIA_VOICE_EN": "en-voice-secret",
            "DEEPGRAM_API_KEY": "dg-supersecret",
            "PUBLIC_HOST": "https://secret-host.example.com",
        }
        rendered = Report(check(secrets)).render()
        for value in secrets.values():
            assert value not in rendered

    def test_malformed_report_does_not_echo_the_bad_value(self) -> None:
        rendered = Report(check(FILLED | {"OPENAI_API_KEY": "leaky-wrong-value"})).render()
        assert "leaky-wrong-value" not in rendered
        assert "OPENAI_API_KEY" in rendered
