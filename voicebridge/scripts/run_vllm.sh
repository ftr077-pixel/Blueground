#!/usr/bin/env bash
# Локальный vLLM для перевода. Делит GPU с whisper/TTS — ограничиваем память.
# Если включаешь Seamless (≈9GB) — переходи на Qwen3-4B-AWQ и util 0.30.
set -e
exec vllm serve Qwen/Qwen3-8B-AWQ \
  --port 8000 \
  --gpu-memory-utilization 0.45 \
  --max-model-len 4096 \
  --disable-log-requests
