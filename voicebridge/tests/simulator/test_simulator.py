"""§8.3 call simulator scenarios — the primary regression gate.

These run at wall-clock speed (~20 s total) and assert on latency
distribution, transcript integrity, barge-in behavior, and the §8.5
feedback-loop chaos case. Latency numbers here measure OUR pipeline overhead
over fake vendors (MT 20 ms, TTS TTFA 10 ms) — they say nothing about real
vendor latency and never satisfy a SPEC §5 gate on their own.
"""

from tests.simulator.harness import SimulatedCall, Utt, assert_no_feedback_loop
from tests.support.fakes import FakeTTS, marker_of, tts_marker

HE_EN_CONVERSATION = [
    Utt("caller", "שלום אני מתקשר לגבי ההזמנה שלי", "Hello I am calling about my order"),
    Utt("operator", "what is your order number please", "מה מספר ההזמנה שלך בבקשה"),
    Utt("caller", "המספר הוא חמש ארבע שלוש", "The number is five four three"),
    Utt("operator", "thank you one moment", "תודה רבה רגע אחד"),
]


async def test_hebrew_english_conversation_end_to_end() -> None:
    call = SimulatedCall(script=list(HE_EN_CONVERSATION))
    report = await call.run()

    assert report.errors == 0
    assert report.queue_drops == 0
    assert report.barge_ins == 0
    assert report.committed_texts == [u.text for u in HE_EN_CONVERSATION]
    assert report.translations_in_order == [u.translation for u in HE_EN_CONVERSATION]

    # Each translation reached the correct leg, and only that leg.
    operator_markers = {tts_marker(u.translation) for u in HE_EN_CONVERSATION if u.side == "caller"}
    caller_markers = {tts_marker(u.translation) for u in HE_EN_CONVERSATION if u.side == "operator"}
    operator_sent = {marker_of(f) for f in report.adapter.sent_frames(report.legs.operator)}
    assert operator_sent == operator_markers
    assert {marker_of(f) for f in report.adapter.sent_frames(report.legs.caller)} == caller_markers

    assert_no_feedback_loop(report, [u.translation for u in HE_EN_CONVERSATION])

    assert len(report.commit_to_first_audio_ms) == 4
    n = len(report.commit_to_first_audio_ms)
    print(
        f"\nsimulator gateway overhead, commit->first_audio over fake vendors: "
        f"p50 {report.p50_ms:.0f} ms, p95 {report.p95_ms:.0f} ms, n={n}"
    )
    assert report.p50_ms < 400.0, f"p50 {report.p50_ms:.0f} ms"
    assert report.p95_ms < 800.0, f"p95 {report.p95_ms:.0f} ms"


async def test_stability_commit_splits_an_utterance_and_both_halves_translate() -> None:
    call = SimulatedCall(
        script=[
            Utt("caller", "טוב, אז אני רוצה לבדוק משהו", "unused-full-text"),
        ]
    )
    # The comma prefix stabilizes and commits early; the ASR final commits the
    # tail. Both fragments must translate independently.
    call_table_patch = {
        "טוב,": "Okay,",
        "אז אני רוצה לבדוק משהו": "so I want to check something",
    }
    report = await call.run_with_table(call_table_patch)

    assert report.errors == 0
    assert report.committed_texts == ["טוב,", "אז אני רוצה לבדוק משהו"]
    triggers = [e.payload["trigger"] for e in report.recorder.named("segment_committed")]
    assert triggers == ["stability", "asr_final"]
    assert report.translations_in_order == ["Okay,", "so I want to check something"]


async def test_operator_barge_in_cancels_caller_translation_within_budget() -> None:
    call = SimulatedCall(
        script=[
            Utt("caller", "אני צריך לספר לך משהו חשוב", "I need to tell you something important"),
            Utt("operator", "wait please stop for a second", "רגע בבקשה עצור לשנייה"),
        ],
        # Long playback so the operator's speech lands mid-utterance.
        tts_a2b=FakeTTS(frame_count=150, frame_interval_ms=15.0),
    )
    report = await call.run()

    assert report.errors == 0
    assert report.barge_ins == 1
    assert report.adapter.flush_count(report.legs.operator) == 1
    cancelled = report.recorder.named("tts_cancelled")
    assert len(cancelled) == 1
    assert cancelled[0].payload["interrupted"] is True

    barge = report.recorder.named("barge_in")[0]
    operator_onsets = [e for e in report.recorder.named("speech_start") if e.direction == "b2a"]
    assert operator_onsets != []
    reaction_ms = barge.monotonic_ts - operator_onsets[0].monotonic_ts
    print(f"\nbarge-in reaction over fakes: {reaction_ms:.0f} ms (budget 300 ms)")
    assert reaction_ms < 300.0

    # The conversation survives: the operator's own utterance still reaches
    # the caller afterwards.
    completed = [e for e in report.recorder.named("tts_completed") if e.direction == "b2a"]
    assert len(completed) == 1
