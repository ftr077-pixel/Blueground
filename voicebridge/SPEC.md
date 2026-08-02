# Real-time bidirectional call translation — engineering specification

Status: v1.0, authoritative. If code and this document disagree, this document wins until it is amended.
Owner: Denis. Implementer: Claude Code.

> **Amendment log**
>
> - **A1 (2026-07-27) — WITHDRAWN by A6.** Had reversed ADR-008 to self-hosted inference.
> - **A2 (2026-07-27) — WITHDRAWN by A6.** Had replaced ADR-003's lineup with self-hosted models.
> - **A6 (2026-07-27, decided by Denis):** A1 and A2 withdrawn. ADR-008 and ADR-003 stand as originally written: all ML inference is a vendor API call, no GPU, no self-hosted models in v1. The revisit triggers in those ADRs are unchanged — self-hosting returns when spend or data residency demands it, and the §6 interfaces are what make that swap cheap.
> - **A3 (2026-07-27):** ADR-002's hot-path resampler is an in-repo half-band FIR. soxr's streaming API was measured unusable for 20 ms frames: ~100 ms of startup silence, 26–66 ms steady-state hold, and its low-latency mode is 17.7 dB SNR.
> - **A4 (2026-07-27):** §6.4 `synthesize` returns a `Synthesis{handle, frames}` — the spec'd signature gave `cancel()` no way to obtain its handle.
> - **A5 (2026-07-27):** §11 dependencies: +`httpx` (HTTP client for vendor REST endpoints); −`soxr`. Stdlib `audioop` pins Python to 3.12 until a replacement is named.
> - **A7 (2026-08-02, requested by Denis):** §1.1 already says the bridge drops into "an inbound **or outbound** voice call", but nothing in §1.2 or §9 let anyone start one. The operator console gains a dial control, and §6.1 gains an `OutboundDialer` protocol alongside `TelephonyAdapter` — placing a call is a control-plane action, not part of the media contract, and it is the one telephony operation that happens before any leg exists. The dialled call joins the same `<Connect><Stream>` path as an inbound one, so the pipeline, the segmenter and ADR-006 are untouched. Until the control plane has auth (M2), the endpoint is fail-closed behind an explicit number allowlist: a public URL with an open dial endpoint is toll fraud waiting to happen, and M0 has no other guard.

---

## 0. TL;DR for the implementer

We are building a service that sits **inside a live phone call** and makes two people who do not share a language talk to each other in real time.

A caller dials a normal phone number and speaks Hebrew. The operator, sitting in a browser, hears English. The operator answers in English. The caller hears Hebrew. Neither party presses a button, waits for a beep, or switches modes. Target end-to-end delay is **1.2–1.5 seconds** from the moment a speaker finishes a clause to the moment the other side hears it.

The system is a **cascade**: streaming ASR → incremental MT → streaming TTS, run twice (once per direction), with a media gateway in the middle that owns the audio plumbing. There is **no GPU**, no self-hosted model, no fine-tuning in v1. Everything is vendor APIs behind our own interfaces.

The hard part is **not** calling the APIs. The hard part is **segmentation, barge-in, and duplex audio management**. Budget your effort accordingly: expect 20% of the work in vendor integration and 80% in the conversational control loop.

---

## 1. Product definition

### 1.1 What we are building

A "translation bridge" that can be dropped into an inbound or outbound voice call.

| Actor | Channel | Language |
|---|---|---|
| Caller | PSTN (regular phone, mobile or landline) | Language A — dynamic, detected or pre-configured |
| Operator | WebRTC in browser (Chrome), headset | Language B — fixed per operator |

Primary market: Israeli call centres and service businesses. The dominant language triples are **Hebrew ↔ Russian**, **Hebrew ↔ English**, **Hebrew ↔ Arabic**, **Russian ↔ English**. Code-switching mid-sentence is normal in this market and must not break the pipeline (see §4.7).

### 1.2 What the operator sees

A single-page web console:

- Connect / disconnect from the call queue.
- Live dual transcript: the caller's original text and its translation, the operator's original text and its translation, in one timeline, updating word by word.
- Latency indicator (per-stage, live).
- A "repeat that" button that re-synthesises the last translated utterance to the other side.
- Post-call: full bilingual transcript, downloadable.

The live transcript is not a nice-to-have. It is the feature that makes the product usable when the audio translation is imperfect — the operator reads what they could not catch. Treat it as P0.

### 1.3 Explicit non-goals for v1

Do not build these. Do not "prepare for" them with abstractions beyond what §6 specifies.

- Voice cloning / speaker-preserving TTS. A neutral voice per language is fine.
- Video.
- More than two participants per call.
- On-premise or air-gapped deployment.
- Self-hosted ASR or TTS models.
- Automatic language detection for the *operator* side (operator language is configured, not detected).
- IVR, call routing logic, CRM integration, ticketing.
- Mobile app for operators.

### 1.4 Success criteria

The system ships when, on **real telephone audio** (8 kHz narrowband, mobile network, background noise), for the Hebrew ↔ Russian pair:

- p50 end-to-end latency ≤ 1.5 s, p95 ≤ 2.5 s, measured per §7.
- Barge-in interrupts outgoing TTS within 300 ms of detected speech onset.
- Zero audio deadlocks or dropped sessions in a 100-call soak test.
- Operator can complete a realistic 5-minute service conversation without switching to a human interpreter.

Note the phrase *real telephone audio*. Vendor demos are recorded on studio microphones. Narrowband telephony audio degrades ASR word error rate materially. Every acceptance test uses recorded real calls, never laptop-mic samples. See §8.2.

---

## 2. Why a cascade and not end-to-end speech-to-speech

Two architectures exist in 2026. End-to-end S2S models (SeamlessM4T-class, or a realtime multimodal LLM) take audio in and emit audio out in one hop. Cascades chain ASR → MT → TTS.

We choose **cascade**. The reasoning, in priority order:

1. **Inspectability.** Every stage emits text. When a translation is wrong, we can see whether the ASR misheard or the MT mistranslated. With an end-to-end model, a bad output is an opaque bad output. For a product whose failure mode is "the customer was told the wrong thing," this is not negotiable.
2. **The transcript is a product feature.** §1.2 requires a live bilingual transcript and a post-call record. A cascade produces this for free. An end-to-end model requires a parallel ASR pass anyway — so we would pay for a cascade *and* an S2S model.
3. **Per-stage vendor swap.** ASR quality for Hebrew and MT quality for Hebrew are different problems with different best-in-class vendors. A cascade lets us pick the best vendor per stage per language pair, and swap one without touching the others. End-to-end locks all three decisions to one vendor.
4. **Latency is comparable in practice.** End-to-end wins on paper by removing serialisation overhead. In practice our latency is dominated by *segmentation* — deciding when a clause is complete enough to translate — which is a problem both architectures share.
5. **Cost control.** We can route cheap utterances to cheap models. See §4.4.

The cost of this choice, stated honestly so nobody re-litigates it later: cascades lose prosody and emotion (the TTS voice is flat regardless of how the speaker sounded), and errors compound across stages. We accept both for v1.

**Revisit trigger:** if a single vendor ships an S2S model with sub-800 ms first-chunk latency, published Hebrew support, and a parallel transcript output, re-evaluate. Not before.

---

## 3. System architecture

### 3.1 Components

```
                        PSTN
                          |
                   [ SIP trunk ]                     [ Browser / WebRTC ]
                          |                                   |
                          +------------ Telephony layer ------+
                                        (Twilio v0 / LiveKit v1)
                                              |
                                    ==========================
                                    |    MEDIA GATEWAY       |   <-- our service
                                    |  session orchestrator  |
                                    ==========================
                                       |                 |
                              Pipeline A→B         Pipeline B→A
                              ASR(A) → MT → TTS(B)   ASR(B) → MT → TTS(A)
                                       |                 |
                                  inject to B        inject to A
```

Supporting services:

- **Control plane** — FastAPI. Session lifecycle, operator auth, WebSocket for the operator console, config, webhooks from the telephony provider.
- **Redis** — live session state, per-session pub/sub for transcript fan-out to the console.
- **Postgres** — call records, transcripts, per-stage latency metrics, cost accounting.
- **S3-compatible object store** — call recordings (both original streams and synthesised streams, separately, for debugging).

### 3.2 Sequence of a single utterance (caller speaks)

1. Telephony layer streams caller audio to the media gateway over a WebSocket. Frames arrive as 20 ms chunks. Twilio sends 8 kHz mu-law base64; LiveKit sends PCM.
2. Gateway decodes to 16-bit PCM, resamples to whatever the ASR vendor wants (16 kHz), and pushes into the A→B pipeline's ASR socket. It simultaneously writes the raw frames to the recording buffer.
3. ASR emits **partial** hypotheses continuously and **final** hypotheses at endpoints.
4. The **segmenter** (§4.3) decides when enough stable text exists to translate. It emits a *commit* — a text span that will not change.
5. MT translates the committed span, with the last N turns of dialogue as context.
6. TTS synthesises the translation, streaming audio chunks back as they are generated.
7. The gateway resamples TTS output to the target channel's format and injects it into the operator's audio stream.
8. The **duplex controller** (§4.6) is watching: if the operator starts speaking while this TTS is playing, playback is cut.
9. Every stage timestamps its input and output. These timestamps go to Postgres and to the operator console's latency indicator.

The reverse direction is identical with A and B swapped. The two pipelines are independent asyncio tasks sharing only the session object and the duplex controller.

---

## 4. Architecture decisions

Each decision below is written as: the decision, the reasoning, the rejected alternative, and the condition under which we would revisit. Do not deviate from these without amending this document.

### ADR-001 — Telephony: Twilio Media Streams for v0, LiveKit for v1

**Decision.** Milestone M0 and M1 use Twilio Programmable Voice with `<Stream>` (Media Streams) to get bidirectional audio over WebSocket. From M3 onward, migrate to self-hosted LiveKit with its SIP bridge.

**Why.** Twilio gets us to a working duplex call in days: point a TwiML bin at our WebSocket, and audio flows. No SIP stack, no media server, no NAT traversal. That speed matters more than anything else at M0 because the risky unknowns in this project are conversational (segmentation, barge-in), not infrastructural — we want to hit those unknowns in week one, not week five.

Twilio's per-minute pricing plus Media Streams surcharge becomes the dominant cost line above roughly 20k minutes/month. LiveKit self-hosted moves that cost to compute we already pay for, gives us native WebRTC for the operator console (Twilio's browser SDK is a separate product with its own quirks), and gives us direct control over jitter buffering and mixing.

**Rejected.** Asterisk / FreeSWITCH with a custom AudioSocket module. Maximum control, maximum operational burden, and we would be writing telephony plumbing instead of the product. Revisit only if a customer demands on-premise.

**Revisit trigger.** M3, or when monthly telephony spend exceeds engineering cost of migration.

**Implementation requirement.** The telephony layer sits behind a `TelephonyAdapter` interface (§6.1) from day one. The rest of the codebase must not import Twilio symbols. This is the single most important abstraction in the project because it is the one we have already committed to replacing.

### ADR-002 — Audio format: normalise to 16 kHz mono PCM16 internally

**Decision.** The gateway converts every inbound stream to 16 kHz mono signed 16-bit little-endian PCM immediately at ingress, and converts outbound at egress. Nothing inside the pipeline handles mu-law, Opus, or 8 kHz.

**Why.** Telephony gives us 8 kHz mu-law. WebRTC gives us Opus. ASR vendors want 16 kHz PCM. TTS vendors emit 22 or 24 kHz. If format conversion is scattered, we will get subtle bugs where a resample happens twice or a sample rate is assumed. One canonical internal format, converted once at each boundary.

Upsampling 8 kHz telephony audio to 16 kHz does not create information that was not there. We do it because the vendors' models are trained at 16 kHz and feeding them their expected rate produces better results than feeding them 8 kHz, even though the underlying audio is band-limited. Do not expect it to fix narrowband quality loss.

**Implementation.** Use `soxr` (via `soxr` Python bindings) for resampling, not naive linear interpolation. Use `audioop` for mu-law codec only.

**Amendment A3 (2026-07-27).** soxr is out of the hot path: measured on 20 ms
chunks its stream API emits nothing for the first ~100 ms and holds 26–66 ms
at steady state (quality-dependent), and its low-latency mode is 17.7 dB SNR.
The only in-pipeline conversion is exactly 2:1 (8 kHz ↔ 16 kHz), implemented
as an in-repo 63-tap half-band windowed-sinc FIR: 1.9 ms group delay,
>50 dB telephony-band SNR, both pinned by tests in `tests/unit/test_audio.py`.
TTS is requested at 16 kHz directly so no other rate exists internally.

### ADR-003 — Hybrid model routing: different models for different jobs

This is the section Denis specifically wants explained, so it is explicit.

We do **not** use one model for everything. We use a deliberately heterogeneous set, because the three stages have genuinely different requirements and the best vendor for each is a different company.

**Stage 1 — ASR. Requirement: lowest possible time-to-stable-text on narrowband, noisy, code-switched audio.**

- Primary: **Deepgram Nova** family for Russian and English. Chosen for latency and streaming maturity — its partial-result cadence is the fastest of the group, and partial cadence is what drives our segmenter.
- Primary for Hebrew: **Speechmatics** or **Gladia**, whichever benchmarks better on our own Hebrew call fixtures. Hebrew is the weak spot in every vendor's lineup; assume the published numbers are optimistic and measure it yourself against §8.2 fixtures before committing.
- The `ASRProvider` interface (§6.2) is per-language-configurable. A session for Hebrew↔Russian may legitimately run two different ASR vendors in its two directions. This is the point of the abstraction.

**Stage 2 — MT. Requirement: correct translation of a *fragment*, with dialogue context, fast.**

Here we run a genuine **two-tier hybrid**, and this is the most interesting design decision in the system.

- **Fast tier — a small, fast LLM** (GPT-4o-mini class, or Gemini Flash). Runs on *every* commit. Its job is to produce a usable translation in under 250 ms. It receives the last 6 turns of dialogue as context plus a domain glossary.
- **Quality tier — a larger model**, run *selectively*, asynchronously, and only when the fast tier signals low confidence or the utterance is long. Its output does not delay audio. Instead it corrects the **transcript shown to the operator** — the operator sees the improved text a beat after hearing the fast translation.

Why this split, rather than just using one model? Because audio and text have different latency tolerances. Audio must be immediate or the conversation collapses; the operator's screen can update 800 ms later and nobody notices. Spending large-model quality on the screen while spending small-model speed on the ear gets us most of the quality benefit at a fraction of the latency cost and roughly a fifth of the token cost. Classical NMT (DeepL, Google Translate) is a valid fallback for the fast tier, but LLMs win here because they hold conversational context and honour a glossary, and translating a *fragment* correctly requires knowing what came before.

**Stage 3 — TTS. Requirement: lowest time-to-first-audio-chunk. Voice quality is secondary.**

- Primary: **Cartesia Sonic** or **ElevenLabs Flash**. Both are in the sub-300 ms TTFA class. Pick on measured TTFA from our region, not on demo quality.
- Requirement: the provider must support **streaming output** and **mid-utterance cancellation**. Cancellation is mandatory — barge-in (§4.6) is impossible without it. Reject any provider that only returns complete audio files.
- Cache synthesised audio for fixed phrases (greetings, hold messages, "one moment please"). Key the cache on `(text, voice_id, language)`.

**Rejected.** A single-vendor stack (e.g. all-Google or all-Azure). Simpler to bill and integrate, meaningfully worse on the axis that matters at each stage, and it couples all three swap decisions together.

**Amendment A2 — WITHDRAWN by A6 (2026-07-27).** A2 had replaced the lineup
above with faster-whisper / vLLM / Piper on a self-hosted GPU. Withdrawn
together with A1; the vendor lineup in this ADR stands. The language pair in
flight is Hebrew ↔ English, so the ASR split that matters is Deepgram for
English and Speechmatics (or Gladia) for Hebrew, decided on §8.2 fixtures.

### ADR-004 — Segmentation: hybrid VAD + ASR endpointing + stability window

**This is the core algorithm of the product. Get it right and the rest is plumbing.**

The problem: ASR emits a stream of continuously-revised partial hypotheses. Translate too early and you translate half a clause, and since Hebrew, Russian and English order words differently, a half-clause often translates to nonsense that must then be contradicted. Translate too late — wait for a full sentence-final pause — and you add a second of latency and the conversation stops feeling live.

**The algorithm.** Emit a commit when *any* of these fire:

1. **ASR endpoint.** The vendor signals a final result. Highest-confidence trigger. Always commit.
2. **Stability window.** A prefix of the partial hypothesis has been unchanged for `STABILITY_MS` (start at 320 ms) across at least two successive partials, AND that prefix ends at a token that looks like a clause boundary (punctuation, or a configured conjunction list per language). Commit the stable prefix only; the unstable tail stays in the buffer.
3. **Hard timeout.** `MAX_UNCOMMITTED_MS` (start at 2500 ms) of continuous speech with no commit. Force a commit at the last word boundary. This guards against a speaker who never pauses.
4. **VAD silence.** Silero VAD (small, CPU, runs locally, no API call) detects `VAD_SILENCE_MS` (start at 500 ms) of silence. Commit everything buffered.

Why hybrid rather than any single trigger: ASR endpointing alone is too slow and vendor-dependent. VAD alone is fooled by the mid-sentence pauses that are normal in unscripted speech. The stability window alone is fooled by an ASR that keeps revising. Together, the fast triggers usually fire first and the slow ones act as guarantees.

All four thresholds are per-session configuration with the defaults above, exposed as environment variables, and logged with every commit so we can tune them from production data. **Do not hard-code them.** Expect to spend real time tuning these numbers; that tuning *is* the product quality work.

### ADR-005 — Commit-only translation, no re-translation of already-spoken audio

**Decision.** Once a span is committed and sent to TTS, it is final. We never re-synthesise a correction into the audio channel. Corrections appear only in the operator's text transcript.

**Why.** Re-translation (where the translation is continuously revised as more audio arrives) is excellent for subtitles and terrible for audio. You cannot un-say a sentence. Emitting "the meeting is Tuesday — sorry, Thursday" as synthesised speech is worse than a 200 ms longer wait for the correct version.

Consequence: the segmenter (ADR-004) carries all the responsibility for not committing prematurely. That is intentional — one place to get right.

### ADR-006 — Duplex control and barge-in

**Decision.** A per-session `DuplexController` owns a small state machine per direction and is the only component allowed to start or stop TTS playback.

States per direction: `IDLE` → `LISTENING` → `TRANSLATING` → `SPEAKING` → `IDLE`.

Rules:

- If side B starts speaking (VAD onset on B's inbound stream) while TTS is playing *to* B, cancel that TTS immediately, flush the outbound buffer, and log a `barge_in` event. The un-played remainder of the cancelled utterance goes to the transcript marked as interrupted.
- Never play TTS to a side while that side is actively speaking. Queue it, and if the queue exceeds `MAX_QUEUE_MS` (3000 ms), drop the oldest entries — stale translation is worse than missing translation.
- Guard against the feedback loop: TTS audio injected into the operator's stream must never be routed back into the operator's ASR. On WebRTC this is handled by browser echo cancellation; on the PSTN side, the injected audio goes into the outbound leg only. **Write an explicit test for this.** A translation loop where the system translates its own output is the single most likely catastrophic bug in this design.

Barge-in cancellation must complete within 300 ms of speech onset. That budget is: VAD detection (~100 ms) + cancel signal to TTS provider (~50 ms) + buffer flush (~50 ms).

### ADR-007 — Code-switching and language handling

**Decision.** Operator language is fixed per operator. Caller language is either pre-configured per inbound number, or detected once in the first 3 seconds and then locked for the session.

We do **not** attempt per-utterance language detection after lock. We do, however, require an ASR that tolerates code-switching within an utterance, because in the Israeli market a Hebrew sentence containing English business terms is not an edge case, it is the norm.

**Handling of already-target-language content.** When a caller speaking Hebrew says an English phrase, the MT prompt instructs the model to preserve, not re-translate, terms already in the target language. Handle this in the prompt, not with code.

**Glossary.** Per-tenant glossary of terms that must never be translated or must be translated a specific way (brand names, product SKUs, street names). Injected into the MT prompt and, where the vendor supports it, into ASR keyterm prompting. This is a P1 feature but design the data model for it in M1.

### ADR-008 — No GPU, no self-hosted models, in v1

**Decision.** All ML inference is a vendor API call. The only local model is Silero VAD, which is a few megabytes and runs on CPU.

**Why.** Our compute is I/O-bound WebSocket relaying. Adding GPU nodes means GPU capacity planning, model serving, warm-up latency, and a second scaling axis — all before we know whether the product works. Vendor APIs cost more per minute and buy us a much shorter path to knowing.

**Revisit trigger.** When monthly ASR+TTS spend exceeds the fully-loaded cost of a GPU fleet plus the engineer to run it, or when a customer's data residency requirements forbid sending audio to third-party APIs. Both are real futures. Neither is now.

**Amendment A1 — WITHDRAWN by A6 (2026-07-27).** A1 had reversed this ADR to
self-hosted inference. Withdrawn on Denis's decision: the vendor-API path
reaches the M0 gate without provisioning GPUs or writing model serving, and
the M0 gate exists to measure Hebrew ASR quality (§13.1) — the project's
largest risk — as early as possible. This ADR stands as written above.

### ADR-009 — Deployment region

**Decision.** Deploy the media gateway to AWS `eu-central-1` (Frankfurt) initially, with `il-central-1` (Tel Aviv) as a measured alternative.

**Why not automatically Tel Aviv, given the operators are in Israel?** Because total latency is operator↔gateway *plus* gateway↔vendor. The ASR, MT and TTS vendors host predominantly in US and EU regions. Tel Aviv wins the first leg and loses the second. Frankfurt often wins overall.

**This is a measurement, not an opinion.** M1 includes a latency probe (§8.4) that measures round-trip to every configured vendor endpoint from both regions over 24 hours. The region decision is made from that data and recorded here as an amendment. Until then, Frankfurt.

---

## 5. Latency budget

Total target: **p50 ≤ 1.5 s**, measured from `speech_end` (the moment the segmenter commits) to `first_audio_out` (the first byte of translated audio leaving the gateway).

| Stage | p50 target | p95 ceiling | Notes |
|---|---|---|---|
| Telephony ingress + network | 120 ms | 250 ms | Fixed cost, not optimisable by us |
| ASR partial → stable commit | 350 ms | 600 ms | Dominated by ADR-004 thresholds |
| MT (fast tier) | 200 ms | 400 ms | Prompt caching helps materially |
| TTS time-to-first-audio | 200 ms | 350 ms | Provider-selection driven |
| Gateway processing + egress | 80 ms | 150 ms | Our code; must stay small |
| **Total** | **~950 ms** | **~1.75 s** | Headroom to the 1.5 s p50 target |

Rules that follow from this budget:

- Every stage boundary emits a timestamped event. No exceptions.
- Any single synchronous operation in the gateway hot path exceeding 10 ms is a bug. Profile it.
- The MT quality tier (ADR-003) is explicitly **outside** this budget — it runs async and never blocks audio.
- If p95 total exceeds 2.5 s, the conversation degrades to unusable. Alert on it.

---

## 6. Interfaces

These are the contracts. Implement against them; do not let vendor SDK types leak past them.

### 6.1 TelephonyAdapter

```python
class TelephonyAdapter(Protocol):
    async def accept_call(self, ctx: CallContext) -> CallLegs:
        """Establish both legs. Returns handles for caller and operator."""
    async def inbound_audio(self, leg: Leg) -> AsyncIterator[AudioFrame]:
        """Yield 20 ms frames of 16 kHz mono PCM16. Adapter owns transcoding."""
    async def send_audio(self, leg: Leg, frame: AudioFrame) -> None:
        """Inject one frame. Adapter owns transcoding to wire format."""
    async def flush_outbound(self, leg: Leg) -> None:
        """Discard queued outbound audio. Used for barge-in."""
    async def hangup(self, leg: Leg) -> None: ...
```

Implementations: `TwilioAdapter` (M0), `LiveKitAdapter` (M3). Both must pass the same adapter conformance test suite.

### 6.2 ASRProvider

```python
class ASRProvider(Protocol):
    async def open(self, language: str, opts: ASROptions) -> None: ...
    async def push(self, frame: AudioFrame) -> None: ...
    async def results(self) -> AsyncIterator[ASRResult]: ...
    async def close(self) -> None: ...

@dataclass
class ASRResult:
    text: str
    is_final: bool
    confidence: float | None
    words: list[Word]          # each with start_ms, end_ms, confidence
    received_at: float          # monotonic, set by us not the vendor
```

Implementations: `DeepgramASR`, `SpeechmaticsASR`, `GladiaASR`. Selection is config-driven per language.

### 6.3 Translator

```python
class Translator(Protocol):
    async def translate(
        self,
        text: str,
        source: str,
        target: str,
        context: list[Turn],       # last N turns, both languages
        glossary: Glossary | None,
        tier: Literal["fast", "quality"],
    ) -> Translation
```

### 6.4 TTSProvider

```python
# Amended per A4: synthesize returns a Synthesis carrying the handle that
# cancel() needs — the original signature returned a bare iterator and left
# the handle unobtainable.
@dataclass
class Synthesis:
    handle: SynthesisHandle
    frames: AsyncIterator[AudioFrame]
    """Must yield the first chunk before synthesis completes."""

class TTSProvider(Protocol):
    def synthesize(self, text: str, voice: VoiceSpec) -> Synthesis: ...
    async def cancel(self, handle: SynthesisHandle) -> None:
        """Abort in-flight synthesis. Must complete in <50 ms."""
```

### 6.5 Session events

Every meaningful moment emits an event to Redis pub/sub (for the console) and to Postgres (for analysis). Minimum event set:

`call_started`, `leg_connected`, `speech_start`, `asr_partial`, `asr_final`, `segment_committed`, `mt_started`, `mt_completed`, `tts_started`, `tts_first_audio`, `tts_completed`, `tts_cancelled`, `barge_in`, `queue_dropped`, `error`, `call_ended`.

Every event carries: `session_id`, `direction` (`a2b` / `b2a`), `monotonic_ts`, `wall_ts`, and a `correlation_id` linking all events belonging to one utterance. The correlation ID is what makes per-stage latency analysis possible. Assign it at `segment_committed` and thread it through.

---

## 7. Observability

Non-negotiable, built in M1 not retrofitted.

- **Structured JSON logs**, one line per event, shipped to whatever aggregator we choose. Never log audio payloads; log frame counts and byte totals.
- **Prometheus metrics**: histograms for each stage latency, counters for barge-ins, cancellations, queue drops, vendor errors, gauge for active sessions.
- **Per-call trace view**: a debug endpoint that returns the full event timeline for one `session_id` as a waterfall. You will use this constantly while tuning ADR-004.
- **Dual recording**: original audio and synthesised audio saved as separate tracks per leg. Mixed recordings are useless for debugging.
- **Cost accounting**: per call, record ASR seconds, MT tokens in/out per tier, TTS characters, telephony minutes. Write it to Postgres. We need real unit economics, not estimates.

---

## 8. Testing strategy

### 8.1 Unit and component

Standard. Segmenter gets the heaviest coverage: it is pure logic over a stream of `ASRResult`, so it is fully testable without any network.

### 8.2 Golden audio fixtures

Build a fixture corpus **before** tuning anything. Requirements:

- Minimum 30 recorded real phone calls, not studio recordings. Mobile and landline. With background noise, hold music bleed, and at least five accents.
- Hebrew, Russian, English, and code-switched samples.
- Each with a human-verified reference transcript and reference translation.
- Stored in S3, downloadable by a make target, never committed to git.

Every ASR vendor evaluation runs against this corpus. Vendor marketing numbers are inadmissible.

### 8.3 Call simulator

A harness that replays fixture audio through the full pipeline at wall-clock speed against a fake `TelephonyAdapter`, and asserts on latency distribution and transcript accuracy. This is the primary regression gate. It must run in CI.

### 8.4 Vendor latency probe

A small always-on job that opens a streaming connection to every configured vendor every 60 s, measures round-trip, and records it. Feeds the ADR-009 region decision and detects vendor degradation before customers do.

### 8.5 Chaos cases that must be explicitly tested

- Vendor WebSocket drops mid-utterance → reconnect without dropping the call.
- Both parties speak simultaneously for 10 s.
- One party is silent for 60 s.
- Caller hangs up mid-TTS.
- TTS provider returns 429.
- Audio feedback loop attempt (ADR-006) — assert it does not occur.

---

## 9. Delivery plan

Each milestone has a demo and an acceptance gate. Do not start the next milestone until the gate passes.

### M0 — Half-duplex spike (target: 5 working days)

One direction only. Caller speaks Hebrew, operator hears Russian. No console, no persistence, no barge-in. Twilio + Deepgram/Speechmatics + GPT-4o-mini + Cartesia, hard-wired.

**Gate:** a real phone call where a Hebrew sentence is heard in Russian in under 3 seconds. Ugly is fine.

Purpose: prove every vendor integration works on real telephony audio and produce the first honest latency numbers.

### M1 — Full duplex + observability (target: 2 weeks)

Both directions. `DuplexController` and barge-in per ADR-006. Segmenter per ADR-004 with configurable thresholds. All interfaces from §6 in place. Full event stream, metrics, dual recording, call simulator in CI. Fixture corpus collected.

**Gate:** two people hold a 5-minute conversation. p50 latency reported and under 2 s. Barge-in works. No feedback loop. Simulator green.

### M2 — Operator console + quality tier (target: 2 weeks)

Web console per §1.2: live bilingual transcript, latency indicator, repeat button. MT quality tier per ADR-003 correcting the transcript asynchronously. Postgres persistence, post-call transcript export. Glossary data model.

**Gate:** an operator who has never seen the system handles a realistic service call unaided.

### M3 — LiveKit migration + scale (target: 2 weeks)

`LiveKitAdapter` passing the same conformance suite. Operator moves to native WebRTC. Horizontal scaling with session affinity. TTS cache. 100-call soak test.

**Gate:** 100 concurrent simulated calls, p95 latency within budget, zero deadlocks, cost per minute measured and recorded.

### M4 — Hardening

Chaos cases from §8.5. Threshold tuning from production data. Cost optimisation. Second and third language pairs.

---

## 10. Repository layout

```
/app
  /telephony        TelephonyAdapter implementations + conformance tests
  /audio            codecs, resampling, framing, VAD wrapper
  /pipeline
    segmenter.py    ADR-004. Pure logic, heavily tested.
    duplex.py       ADR-006 state machine
    orchestrator.py per-session task wiring
  /providers
    /asr            Deepgram, Speechmatics, Gladia
    /mt             fast tier, quality tier, prompt templates
    /tts            Cartesia, ElevenLabs, cache
  /api              FastAPI: control plane, operator WebSocket, webhooks
  /console          frontend (React)
  /storage          Postgres models, S3 recording writer
  /observability    events, metrics, trace endpoint
/tests
  /unit
  /simulator        §8.3
  /fixtures         manifest only; audio lives in S3
/infra              terraform / docker
SPEC.md             this document
CLAUDE.md           working rules for the implementer
```

---

## 11. Technology choices

- **Python 3.12**, `asyncio` throughout. Chosen because every vendor has a mature Python SDK and Denis's existing stack is FastAPI. The gateway is I/O-bound; the GIL is not the constraint. If profiling later shows frame handling is CPU-bound, move only that hot loop, not the service.
- **FastAPI** for control plane, raw `websockets` for media (do not route media through FastAPI's WebSocket layer — unnecessary overhead in the hot path).
- **httpx** for HTTP calls to vendor REST endpoints (added per A5).
- **Pydantic v2** for all boundary types.
- **Redis** for session state and pub/sub. **Postgres** for durable records. **SQLAlchemy 2.x** async.
- **uv** for dependency management, **ruff** for lint and format, **pytest** + `pytest-asyncio`.
- **Docker**, one image, deployed to ECS Fargate or equivalent. Stateless containers, session affinity at the load balancer.
- **React + TypeScript** for the console. No framework beyond Vite. The console is a transcript view, not an application.

---

## 12. Cost model

Per translated minute, both directions, order-of-magnitude:

| Line | Cost/min |
|---|---|
| Telephony (Twilio, inbound + Media Streams) | $0.02–0.04 |
| ASR, two streams | $0.02–0.03 |
| MT fast tier | $0.01–0.02 |
| MT quality tier (selective) | $0.01 |
| TTS, two directions | $0.03–0.06 |
| Compute + infra amortised | $0.01 |
| **Total** | **~$0.10–0.17** |

Track actuals per §7. If the measured number diverges from this table by more than 50%, stop and find out why before scaling.

---

## 13. Known risks

1. **Hebrew ASR quality on narrowband telephony is the single largest technical risk.** Every vendor's Hebrew support is thinner than their English. Measure it in M0. If word error rate on the fixture corpus is unusable, the entire product thesis needs revisiting — better to learn that in week one.
2. **Segmentation tuning is open-ended work.** Budget for it as ongoing product work, not a task that completes.
3. **Vendor dependency.** Three vendors in the critical path, any of which can degrade or change pricing. Mitigated by the interfaces in §6 — keep them clean.
4. **Regulatory.** Recording calls and processing voice data across borders has consent and data-protection implications in Israel and the EU. Not an engineering blocker for M0–M2, but must be resolved before a paying customer. Flag it; do not solve it in code.
