#!/usr/bin/env bash
# Pull latest from GitHub, reinstall deps, rebuild, and restart the app.
# Launched by the dashboard "Update" button via systemd-run, so it runs in its
# own scope and survives the app restart it triggers at the end.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1   # -> app dir (e.g. /opt/rohub)

STATUS=".update-status.json"
write() {
  printf '{"state":"%s","at":"%s","message":"%s"}\n' "$1" "$(date -u +%FT%TZ)" "$2" > "$STATUS"
}

{
  echo "=== update $(date '+%F %T') ==="
  write updating "pulling from GitHub"
  git pull --ff-only || { write error "git pull failed (token expired?)"; exit 1; }
  write updating "installing dependencies"
  npm install || { write error "npm install failed"; exit 1; }
  write updating "building"
  npm run build || { write error "build failed"; exit 1; }
  write done "updated — restarting"
  echo "build ok, restarting service"
  systemctl restart rohub
} >> update.log 2>&1
