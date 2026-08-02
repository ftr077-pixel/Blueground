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
