"""ADR-004 segmenter tests. The segmenter is pure logic over ASRResult
streams and an injected clock, so every trigger is exercised without I/O."""

from app.config import SegmenterConfig
from app.pipeline.languages import ENGLISH, HEBREW, LanguageRules
from app.pipeline.segmenter import CommitTrigger, Segmenter
from app.providers.base import ASRResult

CFG = SegmenterConfig(
    stability_ms=320.0, min_stable_partials=2, max_uncommitted_ms=2500.0, vad_silence_ms=500.0
)


def partial(text: str, at: float) -> ASRResult:
    return ASRResult(text=text, is_final=False, confidence=None, words=(), received_at=at)


def final(text: str, at: float) -> ASRResult:
    return ASRResult(text=text, is_final=True, confidence=None, words=(), received_at=at)


def make(rules: LanguageRules = ENGLISH) -> Segmenter:
    return Segmenter(CFG, rules)


class TestAsrFinalTrigger:
    def test_final_always_commits(self) -> None:
        seg = make()
        assert seg.on_asr_result(partial("hello", 0.0), 0.0) is None
        commit = seg.on_asr_result(final("hello world", 400.0), 400.0)
        assert commit is not None
        assert commit.text == "hello world"
        assert commit.trigger is CommitTrigger.ASR_FINAL

    def test_final_with_nothing_new_commits_nothing(self) -> None:
        seg = make()
        seg.on_asr_result(partial("one two three", 0.0), 0.0)
        vad_commit = seg.on_vad_silence(600.0)
        assert vad_commit is not None and vad_commit.text == "one two three"
        assert seg.on_asr_result(final("one two three", 700.0), 700.0) is None

    def test_state_resets_after_final(self) -> None:
        seg = make()
        seg.on_asr_result(final("first utterance.", 100.0), 100.0)
        commit = seg.on_asr_result(final("second utterance.", 900.0), 900.0)
        assert commit is not None
        assert commit.text == "second utterance."


class TestStabilityTrigger:
    def test_stable_punctuated_prefix_commits(self) -> None:
        seg = make()
        assert seg.on_asr_result(partial("hello there,", 0.0), 0.0) is None
        assert seg.on_asr_result(partial("hello there, how", 100.0), 100.0) is None
        assert seg.on_asr_result(partial("hello there, how are", 200.0), 200.0) is None
        commit = seg.poll(500.0)
        assert commit is not None
        assert commit.text == "hello there,"
        assert commit.trigger is CommitTrigger.STABILITY

    def test_unstable_tail_stays_buffered(self) -> None:
        seg = make()
        seg.on_asr_result(partial("hello there,", 0.0), 0.0)
        seg.on_asr_result(partial("hello there, how", 100.0), 100.0)
        seg.on_asr_result(partial("hello there, how are", 200.0), 200.0)
        assert seg.poll(500.0) is not None
        tail = seg.on_asr_result(final("hello there, how are you", 900.0), 900.0)
        assert tail is not None
        assert tail.text == "how are you"

    def test_commit_can_fire_on_partial_arrival(self) -> None:
        seg = make()
        seg.on_asr_result(partial("ok,", 0.0), 0.0)
        seg.on_asr_result(partial("ok, so", 120.0), 120.0)
        commit = seg.on_asr_result(partial("ok, so the", 400.0), 400.0)
        assert commit is not None
        assert commit.text == "ok,"

    def test_no_clause_boundary_means_no_stability_commit(self) -> None:
        seg = make()
        seg.on_asr_result(partial("i want to", 0.0), 0.0)
        seg.on_asr_result(partial("i want to cancel", 100.0), 100.0)
        assert seg.poll(1000.0) is None

    def test_requires_min_stable_partials(self) -> None:
        seg = make()
        seg.on_asr_result(partial("hello there,", 0.0), 0.0)
        # Prefix is old enough but was only ever seen in one partial.
        assert seg.poll(1000.0) is None

    def test_conjunction_is_a_boundary_and_stays_uncommitted(self) -> None:
        seg = make()
        seg.on_asr_result(partial("i want to cancel", 0.0), 0.0)
        seg.on_asr_result(partial("i want to cancel but", 100.0), 100.0)
        seg.on_asr_result(partial("i want to cancel but keep", 200.0), 200.0)
        commit = seg.poll(600.0)
        assert commit is not None
        assert commit.text == "i want to cancel"

    def test_hebrew_conjunction_boundary(self) -> None:
        seg = make(HEBREW)
        seg.on_asr_result(partial("אני רוצה לבטל", 0.0), 0.0)
        seg.on_asr_result(partial("אני רוצה לבטל אבל", 100.0), 100.0)
        seg.on_asr_result(partial("אני רוצה לבטל אבל רק", 200.0), 200.0)
        commit = seg.poll(600.0)
        assert commit is not None
        assert commit.text == "אני רוצה לבטל"
        assert commit.language == "he"

    def test_revised_prefix_resets_stability_clock(self) -> None:
        seg = make()
        seg.on_asr_result(partial("hello there,", 0.0), 0.0)
        seg.on_asr_result(partial("hello where,", 300.0), 300.0)
        # The revision at 300 ms restarted the clock for the changed token.
        assert seg.poll(400.0) is None
        seg.on_asr_result(partial("hello where, is", 450.0), 450.0)
        commit = seg.poll(700.0)
        assert commit is not None
        assert commit.text == "hello where,"


class TestTimeoutTrigger:
    def test_uncommitted_speech_times_out(self) -> None:
        seg = make()
        seg.on_asr_result(partial("one two three four", 0.0), 0.0)
        seg.on_asr_result(partial("one two three four five", 800.0), 800.0)
        assert seg.poll(2400.0) is None
        commit = seg.poll(2600.0)
        assert commit is not None
        assert commit.text == "one two three four five"
        assert commit.trigger is CommitTrigger.TIMEOUT

    def test_timeout_clock_restarts_after_commit(self) -> None:
        seg = make()
        seg.on_asr_result(partial("one two three four", 0.0), 0.0)
        seg.on_asr_result(partial("one two three four five", 800.0), 800.0)
        first = seg.poll(2600.0)
        assert first is not None and first.trigger is CommitTrigger.TIMEOUT
        # New tail arrives at 2700; its clock starts there, not at 0.
        seg.on_asr_result(partial("one two three four five six", 2700.0), 2700.0)
        assert seg.poll(5100.0) is None
        second = seg.poll(5300.0)
        assert second is not None
        assert second.text == "six"


class TestVadSilenceTrigger:
    def test_silence_commits_everything_buffered(self) -> None:
        seg = make()
        seg.on_asr_result(partial("one two three", 0.0), 0.0)
        commit = seg.on_vad_silence(700.0)
        assert commit is not None
        assert commit.text == "one two three"
        assert commit.trigger is CommitTrigger.VAD_SILENCE

    def test_silence_with_empty_buffer_is_a_no_op(self) -> None:
        seg = make()
        assert seg.on_vad_silence(700.0) is None


class TestCommitFinality:
    """ADR-005: committed text is never re-emitted, even when the ASR revises it."""

    def test_final_that_keeps_committed_words_only_emits_the_tail(self) -> None:
        seg = make()
        seg.on_asr_result(partial("hello there,", 0.0), 0.0)
        seg.on_asr_result(partial("hello there, how", 100.0), 100.0)
        assert seg.poll(500.0) is not None
        commit = seg.on_asr_result(final("hello there, how are you", 900.0), 900.0)
        assert commit is not None
        assert commit.text == "how are you"

    def test_a_final_that_contradicts_committed_words_is_a_new_utterance(self) -> None:
        """The deliberate trade-off in _align: a hypothesis that no longer
        starts with the committed words is treated as the next utterance, so
        an in-place revision of committed words is re-emitted rather than
        dropped. Measured on a live call, an unannounced utterance boundary is
        the common case and cost four translations of one sentence; a vendor
        contradicting words it already finalised has not been observed."""
        seg = make()
        seg.on_asr_result(partial("hello there,", 0.0), 0.0)
        seg.on_asr_result(partial("hello there, how", 100.0), 100.0)
        assert seg.poll(500.0) is not None
        commit = seg.on_asr_result(final("hi there, how are you", 900.0), 900.0)
        assert commit is not None
        assert commit.text == "hi there, how are you"

    def test_correlation_ids_are_unique(self) -> None:
        seg = make()
        a = seg.on_asr_result(final("first.", 100.0), 100.0)
        b = seg.on_asr_result(final("second.", 500.0), 500.0)
        assert a is not None and b is not None
        assert a.correlation_id != b.correlation_id


class TestConfigurability:
    def test_thresholds_come_from_config(self) -> None:
        tight = SegmenterConfig(stability_ms=50.0, min_stable_partials=2)
        seg = Segmenter(tight, ENGLISH)
        seg.on_asr_result(partial("hello,", 0.0), 0.0)
        seg.on_asr_result(partial("hello, you", 30.0), 30.0)
        assert seg.poll(40.0) is None
        assert seg.poll(60.0) is not None

    def test_from_env_reads_spec_variable_names(self) -> None:
        cfg = SegmenterConfig.from_env(
            {"STABILITY_MS": "100", "MAX_UNCOMMITTED_MS": "9000", "VAD_SILENCE_MS": "250"}
        )
        assert cfg.stability_ms == 100.0
        assert cfg.max_uncommitted_ms == 9000.0
        assert cfg.vad_silence_ms == 250.0
        assert cfg.min_stable_partials == 2


class TestCommittedTextIsNeverReEmitted:
    """Measured on a live call: one Hebrew sentence produced four overlapping
    commits and the caller heard the same words translated four times.

    The committed pointer was a bare index into the current hypothesis. When
    the ASR ends one utterance and starts the next, the hypothesis restarts
    from a short prefix and that index silently points into the *new* text, so
    everything after it was committed a second time."""

    def test_a_restarted_hypothesis_does_not_re_emit_committed_text(self) -> None:
        seg = make(HEBREW)
        seg.on_asr_result(partial("אני הגעתי לדירה ואין פה מפתח.", 0.0), 0.0)
        seg.on_asr_result(partial("אני הגעתי לדירה ואין פה מפתח.", 100.0), 100.0)
        first = seg.poll(500.0)
        assert first is not None
        assert first.text == "אני הגעתי לדירה ואין פה מפתח."

        # The ASR closes that utterance and starts a new one from scratch.
        seg.on_asr_result(partial("אני", 600.0), 600.0)
        seg.on_asr_result(partial("אני לא מבין מה לעשות.", 700.0), 700.0)
        seg.on_asr_result(partial("אני לא מבין מה לעשות.", 800.0), 800.0)
        second = seg.poll(1200.0)
        assert second is not None
        assert second.text == "אני לא מבין מה לעשות."

    def test_a_final_after_a_partial_commit_emits_only_the_remainder(self) -> None:
        seg = make()
        seg.on_asr_result(partial("i arrived at the flat,", 0.0), 0.0)
        seg.on_asr_result(partial("i arrived at the flat, and", 100.0), 100.0)
        first = seg.poll(500.0)
        assert first is not None
        assert first.text == "i arrived at the flat,"
        commit = seg.on_asr_result(
            final("i arrived at the flat, and there is no key", 900.0), 900.0
        )
        assert commit is not None
        assert commit.text == "and there is no key"

    def test_a_shrinking_revision_still_never_repeats(self) -> None:
        seg = make()
        seg.on_asr_result(partial("one two three,", 0.0), 0.0)
        seg.on_asr_result(partial("one two three,", 100.0), 100.0)
        first = seg.poll(500.0)
        assert first is not None and first.text == "one two three,"
        # The hypothesis collapses to a shorter revision of the same prefix.
        seg.on_asr_result(partial("one two", 600.0), 600.0)
        seg.on_asr_result(partial("one two three, four five.", 700.0), 700.0)
        seg.on_asr_result(partial("one two three, four five.", 800.0), 800.0)
        second = seg.poll(1200.0)
        assert second is not None
        assert second.text == "four five."


class TestPunctuationIsNotNewText:
    """Measured on a live call: the vendor attaches the closing punctuation
    only when it finalises, so the final's last token differs from the one
    already committed. Compared literally that reads as a different sentence
    and the whole utterance goes out a second time — three of seven delivered
    turns on that call were such duplicates."""

    def test_a_final_that_only_adds_punctuation_commits_nothing(self) -> None:
        seg = make(HEBREW)
        seg.on_asr_result(partial("מה מצב כפרה עליך", 0.0), 0.0)
        vad = seg.on_vad_silence(600.0)
        assert vad is not None and vad.text == "מה מצב כפרה עליך"
        assert seg.on_asr_result(final("מה מצב כפרה עליך.", 700.0), 700.0) is None

    def test_a_final_that_adds_punctuation_and_words_emits_only_the_words(self) -> None:
        seg = make()
        seg.on_asr_result(partial("i entered", 0.0), 0.0)
        vad = seg.on_vad_silence(600.0)
        assert vad is not None and vad.text == "i entered"
        commit = seg.on_asr_result(final("i entered, and it stinks.", 700.0), 700.0)
        assert commit is not None
        assert commit.text == "and it stinks."
