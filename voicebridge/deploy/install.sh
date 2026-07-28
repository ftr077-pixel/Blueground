#!/usr/bin/env bash
# Install VoiceBridge as a service on the box, giving it a permanent address
# so the Twilio webhook is configured once instead of after every restart.
#
# Run as root:
#   bash <repo>/voicebridge/deploy/install.sh
#
# The checkout location is taken from where this script lives, so it works
# regardless of where the repository was cloned.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=/etc/systemd/system/voicebridge.service
UV=/root/.local/bin/uv

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

echo "[1/5] installing uv if needed"
if [[ ! -x "$UV" ]]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

echo "[2/5] installing Python and dependencies into $APP_DIR"
cd "$APP_DIR"
"$UV" python install 3.12
"$UV" sync

echo "[3/5] checking configuration"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat >&2 <<EOF

  $APP_DIR/.env is missing.

  Copy it from your laptop, then re-run this script:
      scp ~/Blueground/voicebridge/.env root@THIS-BOX:$APP_DIR/.env

EOF
  exit 1
fi
chmod 600 "$APP_DIR/.env"
python3 "$APP_DIR/scripts/check_env.py" || {
  echo "configuration incomplete — fix the values above and re-run" >&2
  exit 1
}

echo "[4/5] installing the service"
# Templated rather than copied: the checkout is wherever it is.
cat > "$UNIT" <<EOF
[Unit]
Description=VoiceBridge call translation gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$UV run uvicorn app.api.main:app --host 127.0.0.1 --port 8080
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable voicebridge >/dev/null
systemctl restart voicebridge
sleep 2
if systemctl is-active --quiet voicebridge; then
  echo "     voicebridge is running on 127.0.0.1:8080"
else
  systemctl --no-pager --lines=20 status voicebridge || true
  exit 1
fi

echo
echo "[5/5] the gateway now needs a public HTTPS address"
cat <<'EOF'

  Twilio will not stream audio over plain HTTP — the media socket must be
  wss://, so a certificate is required. Two ways:

  A. ngrok, no domain needed, free static address    (deploy/ngrok.md)
  B. Caddy, if you own a domain                      (deploy/Caddyfile.snippet)

  Useful either way:
     systemctl restart voicebridge     after a git pull
     journalctl -u voicebridge -f      live event log
     curl -s localhost:8080/health     is it alive
EOF
