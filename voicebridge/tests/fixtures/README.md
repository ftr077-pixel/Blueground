# Golden audio fixtures (SPEC.md §8.2)

Audio is **never committed to git**. This directory holds only
`manifest.json`; the audio itself lives in S3 and is fetched by a make target
(to be added when the corpus is collected at M1).

Each manifest entry, once the corpus exists:

```json
{
  "id": "he-mobile-noise-003",
  "language": "he",
  "channel": "mobile",
  "s3_key": "fixtures/he-mobile-noise-003.wav",
  "reference_transcript": "fixtures/he-mobile-noise-003.he.txt",
  "reference_translation": "fixtures/he-mobile-noise-003.en.txt",
  "notes": "hold-music bleed, code-switched product name"
}
```

Corpus requirements (binding, from the spec): ≥30 real phone calls, mobile and
landline, background noise, ≥5 accents, Hebrew/English/code-switched samples
for the current language pair, human-verified reference transcripts and
translations. Vendor evaluations run against this corpus only — vendor
marketing numbers are inadmissible.
