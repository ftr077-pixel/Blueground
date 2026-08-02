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

# Somebody else's site may already own port 80. Taking it would be an outage
# for them, so instead Caddy stays off 80 entirely and proves the domain over
# port 443 (TLS-ALPN-01). The only thing lost is the http:// -> https://
# redirect for this subdomain, and everything that matters here — Twilio's
# webhook, the media socket, the console — is https already.
PORT80_OWNER="$(ss -lptnH 'sport = :80' 2>/dev/null | grep -o 'users:((\"[^\"]*' | cut -d'"' -f2 | head -1 || true)"
if [[ -n "$PORT80_OWNER" && "$PORT80_OWNER" != "caddy"* ]]; then
  echo "     port 80 belongs to '$PORT80_OWNER' — leaving it alone, using 443 only"
  if ! grep -q "auto_https" /etc/caddy/Caddyfile; then
    printf '{\n\tauto_https disable_redirects\n}\n\n%s\n' \
      "$(cat /etc/caddy/Caddyfile)" > /etc/caddy/Caddyfile.new
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  fi
  # The Debian package ships a ":80 { root * /usr/share/caddy; file_server }"
  # welcome site. Caddy binds every site it is given or refuses to start at
  # all, so that one block takes the whole server down — including :443 —
  # when something else already owns port 80.
  if grep -qE '^\s*:80\s*\{' /etc/caddy/Caddyfile; then
    echo "     commenting out the packaged :80 welcome site"
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-voicebridge"
    awk '
      /^[[:space:]]*:80[[:space:]]*\{/ && depth == 0 { inblock = 1 }
      inblock { depth += gsub(/\{/, "{"); depth -= gsub(/\}/, "}"); print "# " $0
                if (depth == 0) inblock = 0
                next }
      { print }
    ' "/etc/caddy/Caddyfile.before-voicebridge" > /etc/caddy/Caddyfile
  fi
fi

cat > "$SITE" <<SITECONF
$DOMAIN {
    reverse_proxy localhost:8080
}
SITECONF

echo "[4/5] reloading caddy"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy || true
sleep 8

# A refused connection on 443 is not slow certificate issuance, it is a server
# that never started. Say which one it is instead of blaming the wait.
if ! systemctl is-active --quiet caddy; then
  echo "" >&2
  echo "  caddy did not start — its own reason:" >&2
  journalctl -u caddy -n 25 --no-pager >&2
  echo "" >&2
  echo "  the configuration it refused is /etc/caddy/Caddyfile" >&2
  exit 1
fi

echo "[5/5] checking from the outside"
if curl -fsS --max-time 25 "https://$DOMAIN/health" | grep -q "^ok"; then
  cat <<DONE

  Working. Put this in Twilio once — 'A call comes in', Webhook, HTTP POST:

      https://$DOMAIN/twilio/voice

  Operator console:   https://$DOMAIN/operator
  Last call timings:  https://$DOMAIN/debug/last-call

  The console signs in through Google when GOOGLE_CLIENT_ID is set, and is
  open to anyone otherwise — 'make check-env' says which. Twilio cannot
  answer a login prompt, so the webhook and media socket stay open either
  way; verifying Twilio's request signature is M2 work.

DONE
else
  echo "  no answer yet — certificate issuance can take a minute" >&2
  echo "  check: journalctl -u caddy -n 40" >&2
  exit 1
fi
