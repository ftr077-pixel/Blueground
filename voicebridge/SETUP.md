# Настройка VoiceBridge — пошагово

Инструкция для того, кто настраивает систему, а не пишет код.
Ничего знать заранее не нужно, все команды можно копировать целиком.

**Главное правило: ключи и пароли никому не пересылаются** — ни в чат, ни в
задачу, ни в письмо. Они живут в одном файле `.env` на твоём компьютере.

---

## Шаг 1. Скачать код к себе

Открой Терминал (на Mac — Cmd+Space, набрать «Терминал») и выполни:

```bash
git clone https://github.com/ftr077-pixel/Blueground.git
cd Blueground/voicebridge
```

Если репозиторий уже скачан — просто зайди в его папку и обнови:

```bash
cd путь/к/Blueground/voicebridge
git pull
```

---

## Шаг 2. Создать файл с настройками

```bash
cp .env.example .env
open -e .env      # на Mac откроется в редакторе; на Linux: nano .env
```

Открылся файл со строчками вида `TWILIO_ACCOUNT_SID=`.
Задача — дописать значение сразу после `=`, без пробелов и без кавычек.

Было:

```
TWILIO_ACCOUNT_SID=
```

Стало (здесь вместо `xxx…` будет твоё настоящее значение):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Сохрани файл (Cmd+S). Этот файл никуда не отправляется: он в `.gitignore`,
git его не видит.

---

## Шаг 3. Где взять каждое значение

| Строчка в файле | Где взять |
|---|---|
| `TWILIO_ACCOUNT_SID` | console.twilio.com, главная страница, панель «Account Info» |
| `TWILIO_AUTH_TOKEN` | там же, нажать «Show» |
| `TWILIO_PHONE_NUMBER` | Twilio → Phone Numbers → Manage → Buy a number (обязательно с галочкой **Voice**), потом скопировать номер из Active numbers |
| `SPEECHMATICS_API_KEY` | portal.speechmatics.com → API keys → Create |
| `OPENAI_API_KEY` | platform.openai.com/api-keys → Create new secret key |
| `CARTESIA_API_KEY` | play.cartesia.ai → API Keys |
| `CARTESIA_VOICE_HE` / `CARTESIA_VOICE_EN` | play.cartesia.ai → библиотека голосов, скопировать ID голоса (иврит и английский) |
| `DEEPGRAM_API_KEY` | console.deepgram.com → API keys (нужен позже, для обратного направления) |
| `PUBLIC_HOST` | появится на шаге 5, пока оставь пустым |

Ключи у всех сервисов выдаются один раз — скопируй сразу, второй раз показать
не смогут. Если потерял — просто создай новый, старый удали.

---

## Шаг 4. Проверить, что всё заполнено

```bash
make check-env
```

Команда напечатает список: что заполнено, что нет, и где взять недостающее.
**Сами значения она не печатает** — этот вывод можно спокойно скинуть мне,
чтобы я подсказал, что не так.

Пример вывода, когда чего-то не хватает:

```
  ok       TWILIO_ACCOUNT_SID
  MISSING  OPENAI_API_KEY  <- platform.openai.com/api-keys
  BAD      TWILIO_PHONE_NUMBER  <- expected international format, e.g. +12025550123

Not ready: fill in OPENAI_API_KEY, TWILIO_PHONE_NUMBER
```

Когда всё готово, последняя строчка будет `Ready for the first call.`

---

## Шаг 5. Запуск и адрес для Twilio

**Пока недоступно** — слой API (сервер, который принимает звонок) ещё
дописывается. Когда он будет готов, здесь появятся:

- команда запуска сервера,
- команда для туннеля (`cloudflared`), который выдаёт публичный адрес
  вида `https://что-то.trycloudflare.com`,
- этот адрес вписывается в `PUBLIC_HOST` в `.env`, а в Twilio — в поле
  **«A call comes in»** у купленного номера (Phone Numbers → номер →
  Voice Configuration).

Отдельный сервер для первого звонка не нужен: достаточно ноутбука и туннеля.
Постоянный сервер понадобится, когда система пойдёт в работу.

---

## Если что-то пошло не так

- `command not found: git` — на Mac выполнить `xcode-select --install`.
- `make: command not found` — использовать вместо `make check-env` команду
  `python3 scripts/check_env.py`.
- Ключ потерян — создать новый в консоли сервиса, старый удалить.
- **Ключ случайно попал в чат или в коммит** — немедленно удалить его в
  консоли сервиса и создать новый. Ключ, который кто-то видел, считается
  скомпрометированным.
