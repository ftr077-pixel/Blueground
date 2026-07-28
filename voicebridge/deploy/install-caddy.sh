#!/usr/bin/env bash
# Give the gateway a permanent HTTPS address on a domain you own.
#
# Caddy obtains and renews the certificate itself, so the Twilio webhook is
# configured once. Preferred over the ngrok route when a domain exists: no
# third party in the call path.
#
# Reads VOICE_DOMAIN from voicebridge/.env. Point that name's DNS A record at
# this box BEFORE running, or the certificate cannot be issued.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
CONF_DIR=/etc/caddy/conf.d
SITE="$CONF_DIR/voicebridge.caddy"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

DOMAIN="$(sed -n 's/^VOICE_DOMAIN=//p' "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '"'"'"' \r')"
if [[ -z "$DOMAIN" ]]; then
  cat >&2 <<MSG

  Add this line to $ENV_FILE and re-run:

      VOICE_DOMAIN=voice.your-domain.com

  and point that name's DNS A record at this box first.

MSG
  exit 1
fi

echo "[1/5] checking DNS"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo unknown)"
if [[ -z "$RESOLVED" ]]; then
  echo "  $DOMAIN does not resolve yet — add the A record and wait a few minutes" >&2
  exit 1
fi
if [[ "$RESOLVED" != "$PUBLIC_IP" && "$PUBLIC_IP" != "unknown" ]]; then
  echo "  $DOMAIN points at $RESOLVED but this box is $PUBLIC_IP" >&2
  echo "  fix the A record before continuing, or the certificate will fail" >&2
  exit 1
fi
echo "     $DOMAIN -> $RESOLVED"

echo "[2/5] installing caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "[3/5] writing the site config"
mkdir -p "$CONF_DIR"
# Keep any existing dashboard config intact: this adds an import line rather
# than replacing the main Caddyfile.
touch /etc/caddy/Caddyfile
if ! grep -q "conf.d/\*.caddy" /etc/caddy/Caddyfile; then
  printf '\nimport %s/*.caddy\n' "$CONF_DIR" >> /etc/caddy/Caddyfile
fi
cat > "$SITE" <<SITECONF
$DOMAIN {
    reverse_proxy localhost:8080
}
SITECONF

echo "[4/5] reloading caddy"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 8

echo "[5/5] checking from the outside"
if curl -fsS --max-time 25 "https://$DOMAIN/health" | grep -q "^ok"; then
  cat <<DONE

  Working. Put this in Twilio once — 'A call comes in', Webhook, HTTP POST:

      https://$DOMAIN/twilio/voice

  Operator console:   https://$DOMAIN/operator
  Last call timings:  https://$DOMAIN/debug/last-call

  The console has no login yet. Twilio cannot answer an auth prompt, so the
  webhook and media socket must stay open; protecting the console and
  verifying Twilio's request signature is M2 work.

DONE
else
  echo "  no answer yet — certificate issuance can take a minute" >&2
  echo "  check: journalctl -u caddy -n 40" >&2
  exit 1
fi
