# Постоянный адрес через ngrok (без своего домена)

Twilio не станет передавать аудио по обычному HTTP: медиа-поток идёт по
`wss://`, а значит нужен сертификат. Если своего домена нет — самый быстрый
путь ngrok: бесплатный тариф даёт **один постоянный адрес**, который больше
не меняется, и TLS в комплекте.

Все команды выполняются **на боксе**, под root.

## 1. Аккаунт и адрес

1. Зарегистрируйся на `dashboard.ngrok.com`
2. Скопируй токен со страницы **Your Authtoken**
3. Открой **Domains** → **Create Domain** — выдадут адрес вида
   `something-static.ngrok-free.app`. Он навсегда твой.

## 2. Установка

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" > /etc/apt/sources.list.d/ngrok.list
apt update && apt install -y ngrok

ngrok config add-authtoken ВСТАВЬ-СВОЙ-ТОКЕН
```

## 3. Служба

```bash
cat > /etc/systemd/system/ngrok.service <<'UNIT'
[Unit]
Description=ngrok tunnel for VoiceBridge
After=network-online.target voicebridge.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ngrok http 8080 --url=ТВОЙ-АДРЕС.ngrok-free.app --log=stdout
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ngrok
```

Проверка:

```bash
curl -s https://ТВОЙ-АДРЕС.ngrok-free.app/health
```

Должно ответить `ok operators_waiting=0`.

## 4. Twilio — один раз и навсегда

Phone Numbers → номер → Voice Configuration → «A call comes in»:

- **Webhook**, метод **HTTP POST**
- `https://ТВОЙ-АДРЕС.ngrok-free.app/twilio/voice`

Больше это поле трогать не придётся.

## Адреса

| Что | Адрес |
|---|---|
| Консоль оператора | `https://ТВОЙ-АДРЕС.ngrok-free.app/operator` |
| Разбор последнего звонка | `https://ТВОЙ-АДРЕС.ngrok-free.app/debug/last-call` |
| Проверка живости | `https://ТВОЙ-АДРЕС.ngrok-free.app/health` |

## Про доступ

Бесплатный ngrok показывает страницу-предупреждение при первом заходе из
браузера — на Twilio это не влияет, а тебе достаточно нажать «Visit Site».

Консоль и отладочная страница сейчас **никак не защищены**. Пока это тесты,
адрес знаешь только ты. Настоящая защита — проверка подписи Twilio и логин
для оператора — относится к M2 вместе с остальным control plane.
