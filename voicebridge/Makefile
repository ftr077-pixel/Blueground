.PHONY: setup check-env preflight dev run tunnel test lint deploy

# uv installs to ~/.local/bin, which is not on PATH until the shell is
# restarted — look there too so `make run` works in the same session that
# ran `make setup`.
UV := $(shell command -v uv 2>/dev/null || echo $(HOME)/.local/bin/uv)

# Deliberately not silenced: this step downloads a Python runtime and can
# sit for a minute, and a quiet terminal is indistinguishable from a hung one.
setup:
	@echo "[1/3] checking for uv..."
	@command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
	@test -x "$(UV)" || { echo "uv not found at $(UV) — see SETUP.md"; exit 1; }
	@echo "[2/3] installing Python 3.12 (may take a minute)..."
	"$(UV)" python install 3.12
	@echo "[3/3] installing dependencies..."
	"$(UV)" sync
	@echo ""
	@echo "setup complete — next: make check-env"

# "|| true" keeps make from printing its own error noise on top of the
# report — the report already says what is missing. Scripts that need the
# exit code call scripts/check_env.py directly.
check-env:
	@python3 scripts/check_env.py || true

preflight:
	@"$(UV)" run python scripts/preflight.py || true

dev:
	@"$(UV)" run python scripts/dev.py

run:
	@test -x "$(UV)" || { echo "uv is missing — run 'make setup' first"; exit 1; }
	@"$(UV)" run uvicorn app.api.main:app --host 0.0.0.0 --port 8080

tunnel:
	@cloudflared tunnel --url http://localhost:8080

# Box-side only: pull the merged branch and restart the service. A pull on
# its own leaves the old code running.
deploy:
	@./deploy/deploy.sh

test:
	@"$(UV)" run pytest -q

lint:
	@"$(UV)" run ruff check app tests && "$(UV)" run ruff format --check app tests && "$(UV)" run mypy
