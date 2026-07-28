.PHONY: check-env test lint

check-env:
	@python3 scripts/check_env.py

test:
	@uv run pytest -q

lint:
	@uv run ruff check app tests && uv run ruff format --check app tests && uv run mypy
