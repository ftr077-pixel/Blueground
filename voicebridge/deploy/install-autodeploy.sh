#!/usr/bin/env bash
# Make the box follow main on its own.
#
# A systemd timer runs deploy/autodeploy.sh every minute: it fetches, and if
# main moved it restarts onto the new commit — after waiting for any call in
# progress to finish. Merge a pull request and the box has it within a minute
# with nothing typed here.
#
# Turn it off at any time with:  systemctl disable --now voicebridge-update.timer
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${INTERVAL:-1min}"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

chmod +x "$APP_DIR/deploy/autodeploy.sh" "$APP_DIR/deploy/deploy.sh"

cat > /etc/systemd/system/voicebridge-update.service <<UNIT
[Unit]
Description=Deploy VoiceBridge if main moved
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/deploy/autodeploy.sh
UNIT

cat > /etc/systemd/system/voicebridge-update.timer <<UNIT
[Unit]
Description=Check for VoiceBridge updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
# Without this a box that was asleep skips the tick it missed.
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now voicebridge-update.timer

cat <<DONE

  The box now follows main, checking every $INTERVAL.

  Merge a pull request and it lands here on its own. A call in progress
  delays the restart until the line is free.

  Watch it:     journalctl -u voicebridge-update -f
  Next check:   systemctl list-timers voicebridge-update
  Turn it off:  systemctl disable --now voicebridge-update.timer

  It only ever deploys the '$( [[ -n "${BRANCH:-}" ]] && echo "$BRANCH" || echo main )'
  branch. If you check out a feature branch by hand it stands aside until you
  switch back, so it will not overwrite what you are working on.

DONE
