#!/usr/bin/env bash
# =============================================================================
# One-shot setup for the Rental Orchestrator Hub + Airbnb visibility scraper
# on a fresh Ubuntu box (e.g. Vultr). Run as root.
#
#   1. Edit the CONFIG block below (or pass the values as env vars).
#   2. Copy this file to the box, then:  sudo bash setup-box.sh
#
# Idempotent — safe to re-run after changing config or to pull new code.
# It installs Node + Caddy, builds the dashboard, runs it under systemd, sets up
# the scraper venv + a daily cron, and (if DOMAIN is set) puts Caddy in front for
# HTTPS + a login.
# =============================================================================
set -euo pipefail

# ------------------------------- CONFIG --------------------------------------
# Private repo URL WITH a token. Create a fine-grained GitHub PAT (Contents:Read)
# and use:  https://<TOKEN>@github.com/ftr077-pixel/Blueground.git
REPO_URL="${REPO_URL:-}"
APP_DIR="${APP_DIR:-/opt/rohub}"
APP_PORT="${APP_PORT:-3000}"

# Your domain — its DNS A record must point at this box's public IP. Leave empty
# to skip Caddy/HTTPS and expose the app on http://<box-ip>:PORT (NO login!).
DOMAIN="${DOMAIN:-}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-admin}"
BASIC_AUTH_PASS="${BASIC_AUTH_PASS:-}"          # required when DOMAIN is set

# Optional dashboard login (HTTP basic auth) — works WITHOUT a domain.
DASHBOARD_USER="${DASHBOARD_USER:-}"
DASHBOARD_PASS="${DASHBOARD_PASS:-}"

# Residential proxy for the scraper — REQUIRED (datacenter IPs get blocked).
PROXY_URL="${PROXY_URL:-}"

# Daily scan time (cron syntax, box local time).
CRON_SCHEDULE="${CRON_SCHEDULE:-0 8 * * *}"
# -----------------------------------------------------------------------------

log()  { echo -e "\n\033[1;36m== $* ==\033[0m"; }
need() { [ -n "${!1:-}" ] || { echo "ERROR: set $1 (CONFIG block or env var)"; exit 1; }; }

need REPO_URL
[ -n "$DOMAIN" ] && need BASIC_AUTH_PASS

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git python3-venv build-essential openssl

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if [ -n "$DOMAIN" ] && ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

log "Fetching the app into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

log "App environment"
ENV_FILE="$APP_DIR/.env.local"
touch "$ENV_FILE"
if ! grep -q '^SCRAPER_API_KEY=' "$ENV_FILE"; then
  echo "SCRAPER_API_KEY=$(openssl rand -hex 16)" >> "$ENV_FILE"
fi
SCRAPER_API_KEY="$(grep '^SCRAPER_API_KEY=' "$ENV_FILE" | cut -d= -f2-)"
# Optional dashboard login. Set DASHBOARD_USER + DASHBOARD_PASS to enable it.
if [ -n "$DASHBOARD_USER" ] && [ -n "$DASHBOARD_PASS" ]; then
  sed -i '/^DASHBOARD_USER=/d; /^DASHBOARD_PASS=/d' "$ENV_FILE"
  printf 'DASHBOARD_USER=%s\nDASHBOARD_PASS=%s\n' "$DASHBOARD_USER" "$DASHBOARD_PASS" >> "$ENV_FILE"
fi

log "Building the dashboard"
npm install
npm run build

log "systemd service for the dashboard"
cat >/etc/systemd/system/rohub.service <<UNIT
[Unit]
Description=Rental Orchestrator Hub (Next.js)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v npm) run start
Restart=always
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rohub
systemctl restart rohub

log "Scraper venv"
cd "$APP_DIR/scraper"
python3 -m venv .venv
./.venv/bin/pip install --quiet -r requirements.txt

if [ -n "$PROXY_URL" ]; then
  log "Daily scan cron ($CRON_SCHEDULE)"
  cat >/etc/cron.d/visibility-scan <<CRON
SHELL=/bin/bash
$CRON_SCHEDULE root cd $APP_DIR/scraper && APP_URL=http://localhost:$APP_PORT SCRAPER_API_KEY=$SCRAPER_API_KEY PROXY_URL='$PROXY_URL' ./.venv/bin/python run_agent.py >> /var/log/visibility-scan.log 2>&1
CRON
  chmod 0644 /etc/cron.d/visibility-scan
else
  log "No PROXY_URL — daily scan left OFF (dashboard-only)"
  rm -f /etc/cron.d/visibility-scan
  echo "The dashboard runs and shows seeded data, but live scanning needs a"
  echo "residential proxy (datacenter IPs get blocked). Re-run with PROXY_URL to enable."
fi

if [ -n "$DOMAIN" ]; then
  log "Caddy (HTTPS + login) for $DOMAIN"
  HASH="$(caddy hash-password --plaintext "$BASIC_AUTH_PASS")"
  cat >/etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    basic_auth {
        $BASIC_AUTH_USER $HASH
    }
    reverse_proxy localhost:$APP_PORT
}
CADDY
  systemctl restart caddy
fi

log "Done"
if [ -n "$DOMAIN" ]; then
  echo "Dashboard:  https://$DOMAIN   (login: $BASIC_AUTH_USER / your password)"
else
  echo "Dashboard:  http://<box-ip>:$APP_PORT   (NO login — set DOMAIN for HTTPS + auth)"
fi
echo "SCRAPER_API_KEY (in $ENV_FILE): $SCRAPER_API_KEY"
echo
if [ -n "$PROXY_URL" ]; then
  echo "Run a scan right now:"
  echo "  cd $APP_DIR/scraper && APP_URL=http://localhost:$APP_PORT \\"
  echo "    SCRAPER_API_KEY=$SCRAPER_API_KEY PROXY_URL='$PROXY_URL' \\"
  echo "    ./.venv/bin/python run_agent.py"
else
  echo "Scanning is OFF (no proxy). Get a residential proxy, then re-run this"
  echo "script with PROXY_URL set to turn on the nightly scan."
fi
echo
echo "Logs:  journalctl -u rohub -f   |   tail -f /var/log/visibility-scan.log"
