.PHONY: check-env test lint

# "|| true" keeps make from printing its own error noise on top of the
# report — the report already says what is missing. Scripts that need the
# exit code call scripts/check_env.py directly.
check-env:
	@python3 scripts/check_env.py || true

test:
	@uv run pytest -q

lint:
	@uv run ruff check app tests && uv run ruff format --check app tests && uv run mypy
