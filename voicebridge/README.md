# VoiceBridge — self-hosted HE⇄EN phone translation

Клиент звонит на Twilio-номер и говорит на иврите. Сотрудник сидит в браузере
и слышит английский перевод. Отвечает на английском — клиент слышит иврит.
Все модели локальные (одна 24GB GPU), Twilio только как PSTN-шлюз.

```
Клиент (иврит) ── PSTN ── Twilio number
                             │  <Connect><Stream>  (WS, 8kHz μ-law)
                             ▼
                    ┌─────────────────────┐
                    │  server/main.py     │  FastAPI + 2 WebSocket endpoints
                    │  CallSession        │  pairing + half-duplex turn-taking
                    ├─────────────────────┤
   he→en pipeline:  │  VAD → ASR(he) → MT → TTS(en)   (cascade)      │
                    │  или SeamlessStreaming S2S (переключается в config)
   en→he pipeline:  │  VAD → ASR(en) → MT → TTS(he)   (cascade only) │
                    └─────────────────────┘
                             │  WS (PCM16 16k + transcript JSON)
                             ▼
                    Сотрудник: operator-client/index.html (браузер, микрофон)
```

## Быстрый старт

```bash
# 1. Модель перевода (отдельный процесс, vLLM OpenAI-compatible)
./scripts/run_vllm.sh

# 2. Сервер
pip install -r requirements.txt
cp .env.example .env        # вписать Twilio creds + PUBLIC_HOST
uvicorn server.main:app --host 0.0.0.0 --port 8080

# 3. Twilio console → номер → Voice webhook:
#    POST https://<PUBLIC_HOST>/twilio/voice
#    (для локальной разработки: ngrok http 8080 или cloudflared tunnel)

# 4. Сотрудник открывает  https://<PUBLIC_HOST>/operator
```

## Структура

| Путь | Что делает |
|---|---|
| `server/main.py` | Twilio webhook (TwiML), WS `/twilio/stream`, WS `/operator/ws`, статика оператора |
| `server/call_session.py` | Сердце системы: пара «клиент↔оператор», half-duplex, роутинг аудио |
| `server/audio.py` | μ-law 8k ⇄ PCM16 16k/24k, ресемплинг |
| `server/pipelines/base.py` | Интерфейс `TranslationPipeline` (audio in → audio out + transcript) |
| `server/pipelines/cascade.py` | ASR → LLM-MT → TTS |
| `server/pipelines/seamless.py` | SeamlessM4T v2 / Streaming для he→en |
| `server/services/` | Обёртки моделей: faster-whisper, vLLM-клиент, MMS-TTS, Kokoro, Silero VAD |
| `operator-client/index.html` | Софтфон оператора: mic → WS, playback, живой транскрипт |
| `config.yaml` | Выбор пайплайнов, имена моделей, пороги VAD |

## Принятые решения

- **Half-duplex (walkie-talkie).** Пока говорит одна сторона, другая ждёт.
  Barge-in — v2. Оригинальный голос собеседнику не транслируется, только перевод.
- **Оркестратор свой, без Pipecat.** Логика half-duplex + два асимметричных
  пайплайна проще в 300 строках своего кода, чем в чужих абстракциях; API
  Pipecat к тому же часто меняется. Интерфейсы (`TranslationPipeline`,
  `VAD`) тонкие — если позже захочется Pipecat, каждый сервис ложится в его
  FrameProcessor один-в-один.
- **he→en переключаемый** (`config.yaml: pipelines.he_en: cascade|seamless`) —
  для A/B на реальных телефонных записях.
- **en→he только каскад** — у Seamless нет иврита на выход.

## GPU-бюджет (24GB)

| Модель | VRAM |
|---|---|
| ivrit-ai whisper-large-v3-turbo (ct2, int8) | ~3 GB |
| faster-whisper small.en | ~1 GB |
| Qwen3-8B AWQ (vLLM, gpu-mem-util 0.45) | ~11 GB |
| MMS-TTS-heb | ~1 GB |
| Kokoro-82M | CPU |
| SeamlessM4T v2 large (если включён) | ~9 GB — тогда возьми Qwen3-4B |

## Известные TODO (помечены в коде)

- SeamlessStreaming (симультанный) — сейчас подключён turn-based M4T v2;
  streaming-агент из `seamless_communication` вставляется в тот же класс.
- Запись звонка + сохранение транскрипта.
- Очередь звонков / несколько операторов (сейчас 1 оператор ↔ 1 звонок).
- Barge-in и дукинг оригинального голоса.
