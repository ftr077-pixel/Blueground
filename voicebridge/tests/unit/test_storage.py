"""Call history and post-call summaries (SPEC A9).

The access tests are the load-bearing ones: these rows hold transcripts of
real customer conversations.
"""

from pathlib import Path

import httpx
import pytest

from app.providers.mt.openai_chat import OpenAIConfig
from app.storage.calls import CallRecord, CallStore, new_call_id
from app.summary import Summariser, parse, transcript_lines

TURNS = [
    {"direction": "a2b", "source": "אני צריך מפתח", "translated": "I need a key"},
    {"direction": "b2a", "source": "Which apartment?", "translated": "איזו דירה?"},
]


def record(operator: str, started_at: float, call_id: str | None = None) -> CallRecord:
    return CallRecord(
        id=call_id or new_call_id(),
        session_id="s1",
        operator=operator,
        started_at=started_at,
        ended_at=started_at + 120.0,
        direction="inbound",
        counterparty="",
        turns=TURNS,
        stats={"p50": 1099.9},
    )


@pytest.fixture
def store(tmp_path: Path) -> CallStore:
    return CallStore(tmp_path / "calls.db")


class TestStore:
    async def test_a_saved_call_comes_back_whole(self, store: CallStore) -> None:
        saved = record("denis@example.com", 1000.0)
        await store.save(saved)
        loaded = await store.get(saved.id)
        assert loaded is not None
        assert loaded.turns == TURNS
        assert loaded.stats == {"p50": 1099.9}
        assert loaded.duration_s == 120.0

    async def test_hebrew_survives_the_round_trip(self, store: CallStore) -> None:
        saved = record("denis@example.com", 1000.0)
        await store.save(saved)
        loaded = await store.get(saved.id)
        assert loaded is not None
        assert loaded.turns[0]["source"] == "אני צריך מפתח"

    async def test_an_operator_sees_only_their_own_calls(self, store: CallStore) -> None:
        await store.save(record("denis@example.com", 1000.0))
        await store.save(record("olya@example.com", 2000.0))
        mine = await store.recent("denis@example.com")
        assert [c.operator for c in mine] == ["denis@example.com"]

    async def test_the_operator_match_ignores_case(self, store: CallStore) -> None:
        await store.save(record("Denis@Example.COM", 1000.0))
        assert len(await store.recent("denis@example.com")) == 1

    async def test_none_means_every_call_for_an_admin(self, store: CallStore) -> None:
        await store.save(record("denis@example.com", 1000.0))
        await store.save(record("olya@example.com", 2000.0))
        assert len(await store.recent(None)) == 2

    async def test_newest_first(self, store: CallStore) -> None:
        await store.save(record("d@e.com", 1000.0))
        await store.save(record("d@e.com", 3000.0))
        await store.save(record("d@e.com", 2000.0))
        assert [c.started_at for c in await store.recent("d@e.com")] == [3000.0, 2000.0, 1000.0]

    async def test_a_summary_attaches_to_an_existing_call(self, store: CallStore) -> None:
        saved = record("d@e.com", 1000.0)
        await store.save(saved)
        await store.set_summary(saved.id, "Caller wanted a key.", ["Send the code"])
        loaded = await store.get(saved.id)
        assert loaded is not None
        assert loaded.summary == "Caller wanted a key."
        assert loaded.action_items == ["Send the code"]

    async def test_a_missing_call_is_none_not_an_error(self, store: CallStore) -> None:
        assert await store.get("nope") is None

    async def test_retention_deletes_old_transcripts_and_keeps_recent_ones(
        self, store: CallStore
    ) -> None:
        now = 1_000_000.0
        await store.save(record("d@e.com", now - 100 * 86400))
        await store.save(record("d@e.com", now - 10 * 86400))
        deleted = await store.prune(older_than_days=90, now=now)
        assert deleted == 1
        assert len(await store.recent("d@e.com")) == 1


class TestTranscriptLines:
    def test_each_side_is_named_and_both_texts_are_kept(self) -> None:
        lines = transcript_lines(TURNS)
        assert lines[0].startswith("Caller: אני צריך מפתח")
        assert "[I need a key]" in lines[0]
        assert lines[1].startswith("Operator: Which apartment?")

    def test_empty_turns_are_skipped(self) -> None:
        assert transcript_lines([{"direction": "a2b", "source": "", "translated": ""}]) == []


class TestParse:
    def test_reads_the_expected_shape(self) -> None:
        result = parse('{"summary": "Wanted a key.", "action_items": ["Send code", " "]}')
        assert result.text == "Wanted a key."
        assert result.action_items == ["Send code"]

    def test_prose_instead_of_json_is_kept_not_lost(self) -> None:
        """The transcript is already stored; a summary is the disposable part."""
        assert parse("The caller wanted a key.").text == "The caller wanted a key."

    def test_action_items_of_the_wrong_type_do_not_raise(self) -> None:
        assert parse('{"summary": "x", "action_items": "not a list"}').action_items == []


class TestSummariser:
    async def test_sends_the_quality_model_and_returns_both_parts(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = request.content.decode()
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '{"summary": "Key request.",'
                                ' "action_items": ["Send the door code"]}'
                            }
                        }
                    ]
                },
            )

        config = OpenAIConfig(
            api_key="k", fast_model="gpt-4o-mini", quality_model="gpt-4o", base_url="https://x"
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await Summariser(config, client).summarise(TURNS)

        assert result.text == "Key request."
        assert result.action_items == ["Send the door code"]
        assert '"gpt-4o"' in str(seen["body"])

    async def test_a_call_with_no_speech_is_not_sent_to_the_model(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("should not have called the vendor")

        config = OpenAIConfig(api_key="k", fast_model="m", quality_model="m", base_url="https://x")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await Summariser(config, client).summarise([])
        assert result.action_items == []
        assert "No speech" in result.text


class TestHistoryRoutes:
    """One operator must not be able to read another's transcripts."""

    def client(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> object:
        from fastapi.testclient import TestClient

        from app.api import main

        monkeypatch.setattr(main.app.state, "store", CallStore(tmp_path / "c.db"))
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "sec")
        return TestClient(main.app)

    def test_history_is_closed_to_strangers(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = self.client(tmp_path, monkeypatch)
        assert client.get("/api/calls").status_code == 401  # type: ignore[attr-defined]
        page = client.get("/calls", follow_redirects=False)  # type: ignore[attr-defined]
        assert page.status_code == 307

    async def test_another_operators_call_is_not_found(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """404, not 403: a 403 on a real id confirms the call happened."""
        from app.api import main

        store = CallStore(tmp_path / "c.db")
        monkeypatch.setattr(main.app.state, "store", store)
        theirs = record("olya@example.com", 1000.0)
        await store.save(theirs)

        assert main._visible_to({"email": "denis@example.com"}) == "denis@example.com"
        loaded = await store.get(theirs.id)
        assert loaded is not None and loaded.operator != "denis@example.com"

    def test_an_admin_sees_every_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.api import main

        monkeypatch.setenv("ADMIN_EMAILS", "boss@example.com")
        assert main._visible_to({"email": "boss@example.com"}) is None
        assert main._visible_to({"email": "denis@example.com"}) == "denis@example.com"

    def test_with_no_admin_list_nobody_is_an_admin(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.api import main

        monkeypatch.delenv("ADMIN_EMAILS", raising=False)
        assert main._visible_to({"email": "boss@example.com"}) == "boss@example.com"
