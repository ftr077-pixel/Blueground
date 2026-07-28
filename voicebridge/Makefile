.PHONY: check-env run tunnel test lint

# "|| true" keeps make from printing its own error noise on top of the
# report — the report already says what is missing. Scripts that need the
# exit code call scripts/check_env.py directly.
check-env:
	@python3 scripts/check_env.py || true

run:
	@uv run uvicorn app.api.main:app --host 0.0.0.0 --port 8080

tunnel:
	@cloudflared tunnel --url http://localhost:8080

test:
	@uv run pytest -q

lint:
	@uv run ruff check app tests && uv run ruff format --check app tests && uv run mypy
