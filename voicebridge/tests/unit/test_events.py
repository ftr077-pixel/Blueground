"""§6.5 / §7 event stream tests, including the no-audio-in-logs guard."""

import io
import json

import pytest

from app.observability.events import EventBus, EventRecorder, JsonLinesSink


def test_audio_payloads_are_rejected() -> None:
    bus = EventBus("s1", ())
    with pytest.raises(TypeError):
        bus.emit("asr_partial", direction="a2b", pcm=b"\x00\x01")


def test_events_carry_the_required_fields() -> None:
    recorder = EventRecorder()
    bus = EventBus("s1", (recorder,))
    bus.emit("segment_committed", direction="a2b", correlation_id="c1", text="hi")
    event = recorder.events[0]
    assert event.session_id == "s1"
    assert event.direction == "a2b"
    assert event.correlation_id == "c1"
    assert event.monotonic_ts > 0
    assert event.wall_ts > 0


def test_json_lines_sink_writes_one_parseable_line() -> None:
    stream = io.StringIO()
    bus = EventBus("s1", (JsonLinesSink(stream),))
    bus.emit("mt_completed", direction="b2a", correlation_id="c2", translated_text="שלום")
    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["name"] == "mt_completed"
    assert record["translated_text"] == "שלום"
    assert record["correlation_id"] == "c2"


def test_recorder_correlation_filter() -> None:
    recorder = EventRecorder()
    bus = EventBus("s1", (recorder,))
    bus.emit("mt_started", direction="a2b", correlation_id="x")
    bus.emit("mt_started", direction="a2b", correlation_id="y")
    bus.emit("mt_completed", direction="a2b", correlation_id="x")
    assert [e.name for e in recorder.for_correlation("x")] == ["mt_started", "mt_completed"]
