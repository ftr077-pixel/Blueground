"""Prompt construction for the MT tiers (ADR-003, ADR-007).

Pure functions so the exact prompt text is unit-testable offline. ADR-007
requires the already-in-target-language rule to live in the prompt, not in
code.
"""

from dataclasses import dataclass

from app.providers.base import Glossary, Turn

_LANGUAGE_NAMES = {"he": "Hebrew", "en": "English", "ru": "Russian", "ar": "Arabic"}


def _language_name(code: str) -> str:
    return _LANGUAGE_NAMES.get(code, code)


@dataclass(frozen=True, slots=True)
class MtPrompt:
    system: str
    user: str


def build_fast_prompt(
    text: str,
    source: str,
    target: str,
    context: list[Turn],
    glossary: Glossary | None,
) -> MtPrompt:
    src, tgt = _language_name(source), _language_name(target)
    rules = [
        f"You translate live phone-call speech from {src} to {tgt}.",
        "The input is a clause fragment from an ongoing conversation, not a full document.",
        f"Reply with the {tgt} translation only — no quotes, no commentary, no alternatives.",
        "Preserve names, numbers and codes exactly.",
        f"If a phrase in the input is already in {tgt}, keep it as-is; do not re-translate it.",
        "If the fragment is incomplete, translate what is there without inventing a completion.",
    ]
    if glossary is not None and glossary.entries:
        lines = []
        for entry in glossary.entries:
            if entry.target is None:
                lines.append(f'- "{entry.source}": never translate, keep verbatim')
            else:
                lines.append(f'- "{entry.source}" -> "{entry.target}"')
        rules.append("Glossary (binding):\n" + "\n".join(lines))
    if context:
        turns = "\n".join(
            f"[{_language_name(t.source_lang)}] {t.source_text}\n"
            f"[{_language_name(t.target_lang)}] {t.translated_text}"
            for t in context
        )
        rules.append("Conversation so far, most recent last:\n" + turns)
    return MtPrompt(system="\n\n".join(rules), user=text)


def build_quality_prompt(
    text: str,
    source: str,
    target: str,
    context: list[Turn],
    glossary: Glossary | None,
    fast_translation: str,
) -> MtPrompt:
    base = build_fast_prompt(text, source, target, context, glossary)
    system = base.system + (
        "\n\nA fast draft translation exists. Improve it only where it is wrong or"
        " unnatural; your output replaces the transcript text, never the audio."
        f'\nDraft: "{fast_translation}"'
    )
    return MtPrompt(system=system, user=text)
