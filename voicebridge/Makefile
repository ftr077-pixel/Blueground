.PHONY: setup check-env run tunnel test lint

# uv installs to ~/.local/bin, which is not on PATH until the shell is
# restarted — look there too so `make run` works in the same session that
# ran `make setup`.
UV := $(shell command -v uv 2>/dev/null || echo $(HOME)/.local/bin/uv)

setup:
	@command -v uv >/dev/null 2>&1 || { \
		echo "installing uv..."; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	}
	@test -x "$(UV)" || { echo "uv not found at $(UV) — see SETUP.md"; exit 1; }
	@"$(UV)" python install 3.12
	@"$(UV)" sync
	@echo "setup complete — next: make check-env"

# "|| true" keeps make from printing its own error noise on top of the
# report — the report already says what is missing. Scripts that need the
# exit code call scripts/check_env.py directly.
check-env:
	@python3 scripts/check_env.py || true

run:
	@test -x "$(UV)" || { echo "uv is missing — run 'make setup' first"; exit 1; }
	@"$(UV)" run uvicorn app.api.main:app --host 0.0.0.0 --port 8080

tunnel:
	@cloudflared tunnel --url http://localhost:8080

test:
	@"$(UV)" run pytest -q

lint:
	@"$(UV)" run ruff check app tests && "$(UV)" run ruff format --check app tests && "$(UV)" run mypy
