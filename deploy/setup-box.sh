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

# External market data (AirROI) — optional. Get a key at airroi.com/developer.
# When set, the pricing engine uses live market data and a daily sync is enabled.
AIRROI_API_KEY="${AIRROI_API_KEY:-}"
AIRROI_REGION_HINT="${AIRROI_REGION_HINT:-Tel Aviv-Yafo, Israel}"

# PriceLabs PDF auto-ingest — watches a drop folder and loads any Market Dashboard
# PDF you export there (no proxy / no login). On by default; harmless no-op when
# the inbox is empty. PRICELABS_NEIGHBORHOOD "*" fans a city-wide report out to
# every portfolio neighborhood.
PRICELABS_INGEST="${PRICELABS_INGEST:-1}"
PRICELABS_NEIGHBORHOOD="${PRICELABS_NEIGHBORHOOD:-*}"

# Daily MiniHotel rates sync (Pull then Push). On by default; the cron self-guards
# — if MiniHotel isn't connected yet the push just no-ops and logs a warning.
RATES_SYNC="${RATES_SYNC:-1}"

# Daily scan time + market-sync time + PriceLabs inbox poll (cron syntax, box local time).
CRON_SCHEDULE="${CRON_SCHEDULE:-0 8 * * *}"
MARKET_CRON_SCHEDULE="${MARKET_CRON_SCHEDULE:-0 7 * * *}"
PRICELABS_CRON_SCHEDULE="${PRICELABS_CRON_SCHEDULE:-*/30 * * * *}"
# MiniHotel rates Pull+Push — runs in Tel Aviv time regardless of the box's
# timezone (see RATES_SYNC_TZ below). Defaults to 01:00 nightly.
RATES_SYNC_CRON_SCHEDULE="${RATES_SYNC_CRON_SCHEDULE:-0 1 * * *}"
RATES_SYNC_TZ="${RATES_SYNC_TZ:-Asia/Jerusalem}"
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
# Optional external market data (AirROI). Stored in .env.local; the app + the
# market-sync cron read it. Re-running with a new key updates it in place.
if [ -n "$AIRROI_API_KEY" ]; then
  sed -i '/^AIRROI_API_KEY=/d; /^AIRROI_REGION_HINT=/d' "$ENV_FILE"
  printf 'AIRROI_API_KEY=%s\nAIRROI_REGION_HINT=%s\n' "$AIRROI_API_KEY" "$AIRROI_REGION_HINT" >> "$ENV_FILE"
fi
# The app's "Run scan now" button falls back to env PROXY_URL when no proxy is
# saved in the UI — keep .env.local in step with the cron so a fresh box can
# scan from the dashboard immediately.
if [ -n "$PROXY_URL" ]; then
  sed -i '/^PROXY_URL=/d' "$ENV_FILE"
  printf 'PROXY_URL=%s\n' "$PROXY_URL" >> "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

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
# Behind Caddy the app must listen on loopback only — bound to 0.0.0.0 the
# raw port would serve the whole dashboard around Caddy's HTTPS + login.
# (The scraper cron and market sync already talk to localhost.)
ExecStart=$(command -v npm) run start${DOMAIN:+ -- -H 127.0.0.1}
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
  # In crontab syntax an unescaped % ends the command (the rest becomes stdin),
  # and proxy credentials are routinely URL-encoded — escape them.
  PROXY_CRON="${PROXY_URL//%/\\%}"
  cat >/etc/cron.d/visibility-scan <<CRON
SHELL=/bin/bash
$CRON_SCHEDULE root cd $APP_DIR/scraper && APP_URL=http://localhost:$APP_PORT SCRAPER_API_KEY=$SCRAPER_API_KEY PROXY_URL='$PROXY_CRON' ./.venv/bin/python run_agent.py >> /var/log/visibility-scan.log 2>&1
CRON
  # Root-only: the file embeds the API key and proxy credentials.
  chmod 0600 /etc/cron.d/visibility-scan
else
  log "No PROXY_URL — daily scan left OFF (dashboard-only)"
  rm -f /etc/cron.d/visibility-scan
  echo "The dashboard runs and shows seeded data, but live scanning needs a"
  echo "residential proxy (datacenter IPs get blocked). Re-run with PROXY_URL to enable."
fi

if [ -n "$AIRROI_API_KEY" ]; then
  log "Daily AirROI market-data sync cron ($MARKET_CRON_SCHEDULE)"
  cat >/etc/cron.d/market-sync <<CRON
SHELL=/bin/bash
$MARKET_CRON_SCHEDULE root curl -fsS -H "x-scraper-key: $SCRAPER_API_KEY" -X POST http://localhost:$APP_PORT/api/market/sync >> /var/log/market-sync.log 2>&1
CRON
  chmod 0600 /etc/cron.d/market-sync
else
  log "No AIRROI_API_KEY — market sync left OFF (engine uses built-in sample signals)"
  rm -f /etc/cron.d/market-sync
fi

if [ "$RATES_SYNC" = "1" ]; then
  log "Daily MiniHotel rates Pull+Push cron ($RATES_SYNC_CRON_SCHEDULE $RATES_SYNC_TZ)"
  # Pull live ARI from MiniHotel, THEN push the Hub's intended prices back out —
  # sequential (single command) so the push reads the freshly-synced calendar and
  # the two never race. Both endpoints accept the shared key via middleware's
  # KEY_BYPASS, so this works whether or not the dashboard login is enabled.
  # CRON_TZ pins the schedule to Tel Aviv time even if the box clock is UTC.
  RATES_API="http://localhost:$APP_PORT"
  cat >/etc/cron.d/rates-sync <<CRON
SHELL=/bin/bash
CRON_TZ=$RATES_SYNC_TZ
$RATES_SYNC_CRON_SCHEDULE root { curl -fsS -H "x-scraper-key: $SCRAPER_API_KEY" -X POST $RATES_API/api/rates/sync && curl -fsS -H "x-scraper-key: $SCRAPER_API_KEY" -X POST $RATES_API/api/rates/push ; } >> /var/log/rates-sync.log 2>&1
CRON
  # Root-only: the file embeds the API key.
  chmod 0600 /etc/cron.d/rates-sync
else
  log "MiniHotel rates auto Pull+Push left OFF (RATES_SYNC != 1)"
  rm -f /etc/cron.d/rates-sync
fi

if [ "$PRICELABS_INGEST" = "1" ]; then
  PRICELABS_INBOX="${PRICELABS_INBOX:-$APP_DIR/scraper/pricelabs-inbox}"
  log "PriceLabs PDF inbox + ingest cron ($PRICELABS_CRON_SCHEDULE)"
  mkdir -p "$PRICELABS_INBOX"
  # No proxy/creds needed — it just parses PDFs you drop in the inbox and posts
  # them to localhost. PRICELABS_NEIGHBORHOOD is single-quoted so '*' isn't globbed.
  cat >/etc/cron.d/pricelabs-pdf <<CRON
SHELL=/bin/bash
$PRICELABS_CRON_SCHEDULE root cd $APP_DIR/scraper && APP_URL=http://localhost:$APP_PORT SCRAPER_API_KEY=$SCRAPER_API_KEY PRICELABS_INBOX='$PRICELABS_INBOX' PRICELABS_NEIGHBORHOOD='$PRICELABS_NEIGHBORHOOD' ./.venv/bin/python pricelabs_ingest_dir.py >> /var/log/pricelabs-pdf.log 2>&1
CRON
  # Root-only: the file embeds the API key.
  chmod 0600 /etc/cron.d/pricelabs-pdf
else
  log "PriceLabs PDF auto-ingest left OFF (PRICELABS_INGEST != 1)"
  rm -f /etc/cron.d/pricelabs-pdf
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
# Don't echo the key/proxy themselves — this output lands in shell history,
# CI logs and scrollback. They live root-readable in $ENV_FILE / /etc/cron.d.
echo "SCRAPER_API_KEY: stored in $ENV_FILE"
echo
if [ -n "$PROXY_URL" ]; then
  echo "Run a scan right now:"
  echo "  cd $APP_DIR/scraper && APP_URL=http://localhost:$APP_PORT \\"
  echo "    SCRAPER_API_KEY=\"\$(grep '^SCRAPER_API_KEY=' $ENV_FILE | cut -d= -f2-)\" \\"
  echo "    PROXY_URL=\"\$(grep '^PROXY_URL=' $ENV_FILE | cut -d= -f2-)\" \\"
  echo "    ./.venv/bin/python run_agent.py"
else
  echo "Scanning is OFF (no proxy). Get a residential proxy, then re-run this"
  echo "script with PROXY_URL set to turn on the nightly scan."
fi
echo
if [ "$PRICELABS_INGEST" = "1" ]; then
  echo "PriceLabs market data: export a Market Dashboard PDF and drop it in"
  echo "  ${PRICELABS_INBOX:-$APP_DIR/scraper/pricelabs-inbox}"
  echo "  (auto-ingested every poll; processed files move to processed/)."
  echo
fi
echo "Logs:  journalctl -u rohub -f   |   tail -f /var/log/visibility-scan.log"
[ "$PRICELABS_INGEST" = "1" ] && echo "       tail -f /var/log/pricelabs-pdf.log"
