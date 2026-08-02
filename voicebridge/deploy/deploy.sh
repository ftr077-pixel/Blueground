#!/usr/bin/env bash
# Put the merged main branch on the box and restart the service.
#
# Pulling alone changes files on disk; the running process keeps executing the
# code it was started with, so a deploy that stops at 'git pull' silently keeps
# serving the old build. That mismatch cost a debugging session already.
set -euo pipefail

BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-voicebridge}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$REPO_ROOT"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH"

echo "deploying $(git log --oneline -1)"

# A restart drops whatever is on the line. Wait for the call to end — up to
# WAIT_FOR_CALL_S, after which a stuck counter must not block updates forever.
WAIT_FOR_CALL_S="${WAIT_FOR_CALL_S:-300}"
waited=0
while [[ $waited -lt $WAIT_FOR_CALL_S ]]; do
    active="$(curl -sf localhost:8080/health | sed -n 's/.*calls_active=\([0-9]*\).*/\1/p')"
    [[ -z "$active" || "$active" == "0" ]] && break
    [[ $waited -eq 0 ]] && echo "a call is in progress — waiting for it to end"
    sleep 5
    waited=$((waited + 5))
done
[[ $waited -ge $WAIT_FOR_CALL_S ]] && echo "still busy after ${WAIT_FOR_CALL_S}s — restarting anyway" >&2

systemctl restart "$SERVICE"

# Give uvicorn a moment to bind before reporting, so a config error that kills
# startup shows up here rather than on the next phone call.
for _ in $(seq 1 20); do
    if curl -sf localhost:8080/health >/dev/null; then
        echo "ok: $(curl -s localhost:8080/health)"
        exit 0
    fi
    sleep 0.5
done

echo "service did not answer /health within 10s:" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2
exit 1
