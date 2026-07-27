# CLAUDE.md — working rules for this repository

Read `SPEC.md` before writing any code. It is the authoritative design document. This file is only about how you work, not what we build.

## Ground rules

1. SPEC.md is binding. If you believe a decision in it is wrong, say so and propose an amendment. Do not silently implement something different. Architecture decisions are numbered (ADR-001 …) so you can reference them precisely.
2. Do not re-litigate settled decisions. The rejected alternatives are listed in each ADR with reasons. If you find yourself about to suggest end-to-end speech-to-speech, a single-vendor stack, or self-hosted models, re-read the relevant ADR first.
3. Interfaces before implementations. Every vendor sits behind a Protocol in `/app/providers` or `/app/telephony`. Vendor SDK types never appear outside those directories. If you need to import `twilio` or `deepgram` in `/app/pipeline`, you have made a mistake.
4. Do not build for milestones we have not reached. No abstraction layers "for later", no plugin systems, no config for features that do not exist. The interfaces in SPEC.md §6 are the only forward-looking abstractions we are paying for, and they exist because we have already committed to swapping those implementations.
5. Do not add dependencies without asking. Justify anything beyond what SPEC.md §11 lists.

## Definition of done

A task is not complete until all of these hold:

* Type hints on every function. `mypy --strict` clean on new code.
* `ruff check` and `ruff format` clean.
* Tests written and passing. For anything touching the segmenter or duplex controller, tests come first.
* Every stage boundary emits its event per SPEC.md §6.5, with the correlation ID threaded through.
* No new synchronous operation over 10 ms in the media hot path.
* No secrets, keys, or phone numbers in code or tests. Everything from environment.
* No audio payloads in logs.

## How to work

* Small commits, one concern each. Conventional commit messages.
* When a task is ambiguous, ask before building. One well-aimed question is cheaper than a wrong implementation. But ask once and then proceed — do not stall on a series of clarifications.
* When you finish a milestone, write a short report: what was built, measured latency numbers, what surprised you, what you would change in SPEC.md. Real numbers, not "it works well".
* Report bad news immediately. If Hebrew ASR accuracy on the fixture corpus is poor, if a vendor's cancellation API does not actually cancel, if the latency budget is unreachable — say so the day you find out. The whole point of the milestone gates is to surface this early.

## Things that will go wrong, and what to do

* Audio feedback loop — the system translates its own TTS output. Highest-severity bug class in this design. There is an explicit test for it (SPEC.md §8.5). Never disable it.
* Sample-rate confusion — double-resampling, or assuming a rate. Everything internal is 16 kHz mono PCM16 (ADR-002). Assert it at boundaries.
* Blocking the event loop — a synchronous resample or file write in the frame path will cause audible stutter, not just slow metrics. Anything CPU-bound goes to a thread pool.
* Vendor WebSocket silently dying — implement heartbeat and reconnect for every streaming vendor connection. Test it by killing the socket mid-utterance.
* Tuning by feel — segmenter thresholds are changed based on the fixture corpus and the call simulator, never based on "this sounded better to me on one call."

## Style

* Prose in code comments explains why, never what. The code says what.
* Docstrings on public interfaces only.
* Prefer boring, explicit code. This is a system where a subtle bug means a customer is told the wrong thing.
* No clever async patterns. Plain `asyncio.TaskGroup`, plain queues.

## Communicating with Denis

* Be terse. No preamble, no summarising back what he asked.
* Lead with the answer or the result, then the reasoning if it is needed.
* Real numbers, always. "p50 1.34 s over 40 fixture calls" not "latency looks good".
* If something is a guess, label it a guess.
