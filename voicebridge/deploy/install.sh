#!/usr/bin/env bash
# Install VoiceBridge as a service on the Ubuntu box that already runs the
# dashboard. Gives the gateway a permanent address, so the Twilio webhook is
# configured once instead of after every tunnel restart.
#
# Run as root, from anywhere:
#   bash /opt/blueground/voicebridge/deploy/install.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/blueground/voicebridge}"
UNIT=/etc/systemd/system/voicebridge.service

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "no checkout at $APP_DIR — clone the repo there first" >&2
  exit 1
fi

echo "[1/5] installing uv if needed"
if [[ ! -x /root/.local/bin/uv ]]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

echo "[2/5] installing Python and dependencies"
cd "$APP_DIR"
/root/.local/bin/uv python install 3.12
/root/.local/bin/uv sync

echo "[3/5] checking configuration"
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo
  echo "  $APP_DIR/.env is missing."
  echo "  Copy .env.example there and fill in the keys, then re-run this script."
  echo "  Never commit that file."
  exit 1
fi
chmod 600 "$APP_DIR/.env"
python3 "$APP_DIR/scripts/check_env.py" || {
  echo "configuration incomplete — fix the values above and re-run" >&2
  exit 1
}

echo "[4/5] installing the service"
install -m 644 "$APP_DIR/deploy/voicebridge.service" "$UNIT"
systemctl daemon-reload
systemctl enable voicebridge
systemctl restart voicebridge
sleep 2
systemctl --no-pager --lines=15 status voicebridge || true

echo
echo "[5/5] next steps"
cat <<'EOF'

  1. Point a subdomain's DNS A record at this box, e.g. voice.your-domain.com

  2. Append deploy/Caddyfile.snippet to /etc/caddy/Caddyfile, replacing the
     hostname and the password hash:
         caddy hash-password --plaintext "your-password"
     then:  systemctl reload caddy

  3. In Twilio, set 'A call comes in' to (this never changes again):
         https://voice.your-domain.com/twilio/voice     Webhook, HTTP POST

  Useful afterwards:
     systemctl restart voicebridge     restart after a git pull
     journalctl -u voicebridge -f      live event log
EOF
