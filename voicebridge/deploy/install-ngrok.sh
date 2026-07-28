#!/usr/bin/env bash
# Give the gateway a permanent public HTTPS address without owning a domain.
#
# Twilio streams call audio over wss://, so a certificate is mandatory; the
# free ngrok tier hands out one fixed address, which means the webhook is
# configured once instead of after every restart.
#
# Reads NGROK_AUTHTOKEN and NGROK_DOMAIN from voicebridge/.env so the token
# never lands in shell history.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

read_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '"'"'"' \r'; }

TOKEN="$(read_value NGROK_AUTHTOKEN || true)"
DOMAIN="$(read_value NGROK_DOMAIN || true)"

if [[ -z "$TOKEN" || -z "$DOMAIN" ]]; then
  cat >&2 <<MSG

  Add these two lines to $ENV_FILE and re-run:

      NGROK_AUTHTOKEN=...        dashboard.ngrok.com -> Your Authtoken
      NGROK_DOMAIN=...           dashboard.ngrok.com -> Domains -> Create Domain
                                 (looks like  some-words.ngrok-free.dev)

MSG
  exit 1
fi

echo "[1/4] installing ngrok"
if ! command -v ngrok >/dev/null 2>&1; then
  curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
  echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
    > /etc/apt/sources.list.d/ngrok.list
  apt-get update -qq
  apt-get install -y -qq ngrok
fi
NGROK="$(command -v ngrok)"

# Accept the domain with or without a scheme; ngrok wants the full URL.
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%/}"

echo "[2/4] registering the token"
"$NGROK" config add-authtoken "$TOKEN" >/dev/null

echo "[3/4] installing the tunnel service"
cat > /etc/systemd/system/ngrok.service <<UNIT
[Unit]
Description=ngrok tunnel for VoiceBridge
After=network-online.target voicebridge.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NGROK http 8080 --url=https://$DOMAIN --log=stdout
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ngrok >/dev/null
systemctl restart ngrok
sleep 5

echo "[4/4] checking from the outside"
if curl -fsS --max-time 15 "https://$DOMAIN/health" | grep -q "^ok"; then
  cat <<DONE

  Working. Put this in Twilio once — 'A call comes in', Webhook, HTTP POST:

      https://$DOMAIN/twilio/voice

  Operator console:   https://$DOMAIN/operator
  Last call timings:  https://$DOMAIN/debug/last-call

DONE
else
  echo "  the address did not answer yet — check: journalctl -u ngrok -n 30" >&2
  exit 1
fi
