"""MT prompt construction tests (ADR-003 tiers, ADR-007 language handling)."""

from app.providers.base import Glossary, GlossaryEntry, Turn
from app.providers.mt.prompts import build_fast_prompt, build_quality_prompt


def test_fast_prompt_names_both_languages_and_preserve_rule() -> None:
    prompt = build_fast_prompt("שלום", "he", "en", context=[], glossary=None)
    assert "Hebrew" in prompt.system
    assert "English" in prompt.system
    # ADR-007: already-target-language content is preserved via the prompt.
    assert "keep it as-is" in prompt.system
    assert prompt.user == "שלום"


def test_glossary_entries_are_binding_lines() -> None:
    glossary = Glossary(
        entries=(
            GlossaryEntry(source="Blueground", target=None),
            GlossaryEntry(source="דירת סטודיו", target="studio apartment"),
        )
    )
    prompt = build_fast_prompt("text", "he", "en", context=[], glossary=glossary)
    assert '"Blueground": never translate' in prompt.system
    assert '"דירת סטודיו" -> "studio apartment"' in prompt.system


def test_context_turns_appear_in_order() -> None:
    context = [
        Turn(
            direction="a2b",
            source_lang="he",
            target_lang="en",
            source_text="שלום",
            translated_text="Hello",
        ),
        Turn(
            direction="b2a",
            source_lang="en",
            target_lang="he",
            source_text="Hi there",
            translated_text="שלום לך",
        ),
    ]
    prompt = build_fast_prompt("מה שלומך", "he", "en", context=context, glossary=None)
    assert prompt.system.index("שלום") < prompt.system.index("Hi there")


def test_quality_prompt_carries_the_fast_draft() -> None:
    prompt = build_quality_prompt(
        "שלום", "he", "en", context=[], glossary=None, fast_translation="Hello"
    )
    assert 'Draft: "Hello"' in prompt.system
    assert "replaces the transcript" in prompt.system
