#!/usr/bin/env bash
# One tick of the auto-deploy loop: if main moved, deploy it.
#
# Pull-based on purpose. A push-based deploy needs an SSH key living in
# GitHub's secrets and an inbound path to the box; this needs neither, works
# behind any firewall, and retries by itself on the next tick if a deploy
# fails. The cost is that an update lands within a minute rather than
# instantly, which is the right trade for a box with one operator.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-main}"
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"

cd "$REPO_ROOT"

# A detached HEAD or a feature branch means somebody is working by hand.
# Deploying over that would throw their work away.
current="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current" != "$BRANCH" ]]; then
    echo "on '$current', not '$BRANCH' — leaving it alone"
    exit 0
fi

git fetch --quiet origin "$BRANCH"
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "origin/$BRANCH")"
if [[ "$local_head" == "$remote_head" ]]; then
    exit 0
fi

echo "$BRANCH moved ${local_head:0:7} -> ${remote_head:0:7}"
exec "$APP_DIR/deploy/deploy.sh"
