"""Per-language clause-boundary rules for the segmenter (ADR-004).

The conjunction lists are deliberately small: a false boundary costs a bad
half-clause translation (ADR-005 makes it permanent), so only tokens that
almost always open a new clause belong here. Tuning happens against the
fixture corpus, never by feel.
"""

from dataclasses import dataclass

CLAUSE_PUNCTUATION = (".", "?", "!", ",", ";", ":", "…")


@dataclass(frozen=True, slots=True)
class LanguageRules:
    code: str
    clause_conjunctions: frozenset[str]


HEBREW = LanguageRules(
    code="he",
    clause_conjunctions=frozenset({"אבל", "כי", "אז", "ואז", "וגם", "או", "אולם", "לכן"}),
)

ENGLISH = LanguageRules(
    code="en",
    clause_conjunctions=frozenset({"and", "but", "so", "because", "then", "or", "although"}),
)

RULES_BY_LANGUAGE = {rules.code: rules for rules in (HEBREW, ENGLISH)}


def rules_for(language: str) -> LanguageRules:
    try:
        return RULES_BY_LANGUAGE[language]
    except KeyError:
        raise KeyError(f"no segmenter language rules for {language!r}") from None
