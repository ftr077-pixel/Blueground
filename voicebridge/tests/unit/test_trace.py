"""Trace tests: the waterfall must report real per-stage numbers and must
not silently count an utterance as delivered when no audio ever played."""

from app.observability.events import EventBus
from app.observability.trace import CallTrace


def record() -> tuple[CallTrace, EventBus]:
    trace = CallTrace()
    return trace, EventBus("s1", (trace,))


class TestSummary:
    def test_a_full_utterance_reports_each_stage(self) -> None:
        trace, bus = record()
        bus.emit("call_started")
        bus.emit(
            "segment_committed",
            direction="a2b",
            correlation_id="c1",
            trigger="asr_final",
            text="שלום",
        )
        bus.emit("mt_started", direction="a2b", correlation_id="c1")
        bus.emit(
            "mt_completed",
            direction="a2b",
            correlation_id="c1",
            source_text="שלום",
            translated_text="Hello",
        )
        bus.emit("tts_started", direction="a2b", correlation_id="c1")
        bus.emit("tts_first_audio", direction="a2b", correlation_id="c1")
        summary = trace.summary()
        assert summary["utterances"] == 1
        assert summary["delivered_to_audio"] == 1
        turn = summary["turns"][0]
        assert turn["source"] == "שלום"
        assert turn["translated"] == "Hello"
        assert turn["trigger"] == "asr_final"
        assert turn["commit_to_audio_ms"] is not None
        assert turn["mt_ms"] is not None

    def test_an_utterance_that_never_reached_audio_is_not_counted(self) -> None:
        trace, bus = record()
        bus.emit("call_started")
        bus.emit("segment_committed", direction="a2b", correlation_id="c1", text="שלום")
        bus.emit("mt_started", direction="a2b", correlation_id="c1")
        summary = trace.summary()
        assert summary["utterances"] == 1
        assert summary["delivered_to_audio"] == 0
        assert summary["commit_to_first_audio_ms"]["p50"] is None
        assert summary["turns"][0]["commit_to_audio_ms"] is None

    def test_errors_and_barge_ins_are_surfaced(self) -> None:
        trace, bus = record()
        bus.emit("call_started")
        bus.emit("error", direction="a2b", correlation_id="c1", stage="mt_tts", detail="boom")
        bus.emit("barge_in", direction="a2b", correlation_id="c2")
        summary = trace.summary()
        assert summary["barge_ins"] == 1
        assert summary["errors"][0]["detail"] == "boom"

    def test_a_new_call_replaces_the_previous_one(self) -> None:
        trace, bus = record()
        bus.emit("call_started")
        bus.emit("segment_committed", direction="a2b", correlation_id="old", text="old")
        # A new call means a new session ID, which is what resets the trace.
        second = EventBus("s2", (trace,))
        second.emit("call_started")
        second.emit("segment_committed", direction="a2b", correlation_id="new", text="new")
        summary = trace.summary()
        assert summary["session_id"] == "s2"
        assert [t["source"] for t in summary["turns"]] == ["new"]

    def test_a_call_that_dies_before_call_started_still_reports_its_error(self) -> None:
        """Setup failures (bad key, quota, unknown voice) arrive before
        ``call_started``; they must replace the previous call, not append to it."""
        trace, bus = record()
        bus.emit("call_started")
        bus.emit("segment_committed", direction="a2b", correlation_id="old", text="old")
        failed = EventBus("s2", (trace,))
        failed.emit("error", stage="session_setup", detail="RuntimeError('quota')")
        summary = trace.summary()
        assert summary["session_id"] == "s2"
        assert summary["turns"] == []
        assert summary["errors"] == [
            {"stage": "session_setup", "detail": "RuntimeError('quota')", "name": "error"}
        ]

    def test_empty_trace_does_not_explode(self) -> None:
        trace = CallTrace()
        summary = trace.summary()
        assert summary["utterances"] == 0
        assert summary["commit_to_first_audio_ms"]["p50"] is None
