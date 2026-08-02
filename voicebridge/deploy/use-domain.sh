#!/usr/bin/env bash
# Move the gateway onto a domain you own, in one command.
#
#     sudo bash deploy/use-domain.sh voice.your-domain.com
#
# Switching address touches four places, and forgetting one of them fails in a
# way that only shows up on the next phone call. This does the two it can —
# .env and Caddy — and prints the exact strings for the two it cannot, because
# Twilio and Google are behind logins that belong to you.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
DOMAIN="${1:-}"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0 ${DOMAIN:-voice.your-domain.com}" >&2
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "usage: sudo bash $0 voice.your-domain.com" >&2
  exit 1
fi
if [[ "$DOMAIN" =~ ^https?:// ]]; then
  echo "give the bare hostname, no https:// prefix" >&2
  exit 1
fi

# Replace the line if it exists, append if it does not — running this twice
# with different domains must not leave both behind.
set_env() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

echo "[1/3] pointing the configuration at $DOMAIN"
set_env VOICE_DOMAIN "$DOMAIN"
set_env PUBLIC_HOST "https://$DOMAIN"

echo "[2/3] issuing the certificate and starting the proxy"
bash "$APP_DIR/deploy/install-caddy.sh"

echo "[3/3] restarting on the new address"
systemctl restart voicebridge

cat <<NEXT

  Done here. Two things are behind your own logins:

  1. Twilio  ->  Phone Numbers  ->  your number  ->  "A call comes in"
     Webhook, HTTP POST:

         https://$DOMAIN/twilio/voice

  2. Google Cloud  ->  APIs & Services  ->  Credentials  ->  your OAuth client
     Authorised redirect URIs — add exactly:

         https://$DOMAIN/auth/callback

     Sign-in fails with redirect_uri_mismatch until that string matches
     character for character.

  Then open  https://$DOMAIN/operator

NEXT
